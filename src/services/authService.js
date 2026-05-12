/**
 * Authentication Service
 * 
 * Business logic for authentication operations
 */

import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { generateToken } from '../middleware/auth.js';
import { generateOrgKey, getMasterKeyHex } from '../config/encryption.js';
import { registerTenant } from '../db/router.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { UserRepository } from '../repositories/userRepository.js';
import getRouterModels from '../db/models/routerModels.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { decrypt, isEncrypted } from '../utils/encryption.js';
import emailService from './emailService.js';
import { buildAuditorPermissions } from '../utils/auditorAccess.js';

const SALT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// MFA-on-login: flag-gates only the login OTP challenge. Enrollment
// fields and the per-action mfa middleware are untouched so flipping
// this is the only switch needed. Set to true so any user with
// `mfa_enabled: true` is challenged for the 4-digit OTP after sign-in.
const MFA_LOGIN_ENABLED = true;

/**
 * Load permissions granted by the user's position (if they are a board member with position_id).
 * Shared helper used by login, OTP completion and runtime permission refresh.
 *
 * @param {Object} tenantDb - Tenant DB connection
 * @param {string} userId - User _id
 * @param {string} orgId - Organization _id
 * @returns {Promise<string[]>} granted_permissions from Position, or []
 */
export const getPositionPermissionsForUser = async (tenantDb, userId, orgId) => {
  try {
    const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
    const { PositionRepository } = await import('../repositories/positionRepository.js');
    const boardMemberRepo = new BoardMemberRepository(tenantDb);
    const positionRepo = new PositionRepository(tenantDb);
    const Position = positionRepo.Position;

    // Get ALL active board_members (user may hold multiple positions after transfer)
    const allBoardMembers = await boardMemberRepo.findAllActiveByUserId(userId, orgId);
    if (!allBoardMembers || allBoardMembers.length === 0) return [];

    const positionIds = allBoardMembers
      .map(bm => bm.position_id)
      .filter(Boolean);
    let positions = [];
    if (positionIds.length > 0) {
      positions = await Promise.all(positionIds.map((pid) => positionRepo.findById(pid)));
    } else {
      // Fallback: some legacy/onboarding-created records can have a role title but no position_id.
      // Attempt to resolve a Position by matching the boardMember's position/custom title.
      const titles = Array.from(
        new Set(
          allBoardMembers
            .flatMap((bm) => [bm?.position, bm?.custom_position_title])
            .map((t) => (typeof t === 'string' ? t.trim() : ''))
            .filter(Boolean)
        )
      );
      if (titles.length > 0 && Position) {
        const ors = titles.map((t) => ({ title: { $regex: `^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }));
        positions = await Position.find({ org_id: orgId, is_active: true, $or: ors }).lean();
      }
    }
    if (!positions || positions.length === 0) return [];

    const result = [];

    for (const position of positions) {
      if (!position) continue;

      if (Array.isArray(position.granted_permissions) && position.granted_permissions.length) {
        result.push(...position.granted_permissions.filter(p => typeof p === 'string' && p.trim()));
      }
    }

    // Known sidebar modules - used for defaults when module_permissions is empty
    const MODULE_IDS = [
      // Core navigation
      'dashboard',
      'calendar',
      'meetings',
      'approval_workflow',
      'audit_trail',
      'complaints',

      // Charity Administration (and submodules)
      'charity_admin',
      'charity_admin_registrations',
      'charity_admin_responsible_people',
      'charity_admin_governing_docs',
      'charity_admin_approval_thresholds',

      // Governance + operations
      'policies',
      'human_resources',
      'financial_mgmt',
      'donation_boxes',
      'risk_mgmt',

      // Funding + marketing
      'programs',
      'grants_donors',
      'social_media_campaigns',

      // Reporting
      'reporting',

      // Systems & Compliance (and submodules)
      'systems_legal',
      'bcp',
      'asset_mgmt',
      'legal_docs',

      // Support
      'support_tickets',
    ];

    // Fixed modules: dashboard & audit_trail (view only), approval_workflow & human_resources (view+edit)
    const FIXED_VIEW_ONLY = ['dashboard', 'audit_trail'];
    const FIXED_VIEW_EDIT = ['approval_workflow', 'human_resources'];

    // Merge module_permissions from all positions (most permissive wins)
    const permsMap = {};
    for (const position of positions) {
      if (!position) continue;
      if (Array.isArray(position.module_permissions) && position.module_permissions.length) {
        for (const mp of position.module_permissions) {
          if (!mp || !mp.module_id) continue;
          const mod = mp.module_id.toString();
          if (!permsMap[mod]) {
            permsMap[mod] = { view: false, edit: false, delete: false };
          }
          if (mp.view) permsMap[mod].view = true;
          if (mp.edit) permsMap[mod].edit = true;
          if (mp.delete) permsMap[mod].delete = true;
        }
      }
    }

    // Default: all modules get view when not explicitly set
    for (const mod of MODULE_IDS) {
      if (permsMap[mod]) {
        if (permsMap[mod].view) result.push(`module:${mod}:view`);
        if (permsMap[mod].edit) result.push(`module:${mod}:edit`);
        if (permsMap[mod].delete) result.push(`module:${mod}:delete`);
      } else {
        // No permissions set - use defaults
        const isFixedViewEdit = FIXED_VIEW_EDIT.includes(mod);
        result.push(`module:${mod}:view`);
        if (isFixedViewEdit) result.push(`module:${mod}:edit`);
      }
    }

    // Deduplicate and return
    return Array.from(new Set(result));
  } catch (err) {
    logError('Failed to load position permissions for user', err, { userId, orgId });
    return [];
  }
};

/**
 * Decrypt user fields with master key (used when plugin hasn't run or for plain objects)
 */
const decryptUserFields = (userDoc, keyHex) => {
  const userObj = userDoc.toObject ? userDoc.toObject() : userDoc;
  const decrypted = { ...userObj };
  if (!keyHex || keyHex.length !== 64) return decrypted;

  if (userObj.email && isEncrypted(userObj.email)) {
    try { decrypted.email = decrypt(userObj.email, keyHex); } catch (e) { logError('Failed to decrypt email', e); }
  }
  if (userObj.first_name && isEncrypted(userObj.first_name)) {
    try { decrypted.first_name = decrypt(userObj.first_name, keyHex); } catch (e) { logError('Failed to decrypt first_name', e); }
  }
  if (userObj.last_name && isEncrypted(userObj.last_name)) {
    try { decrypted.last_name = decrypt(userObj.last_name, keyHex); } catch (e) { logError('Failed to decrypt last_name', e); }
  }
  return decrypted;
};

export class AuthService {
  async register(registerData) {
    const { email, password, organizationName, firstName, lastName } = registerData;

    try {
      const routerModels = getRouterModels();

      // Validate organisation name produces a valid identifier (used for DB name; max 50 chars)
      const orgId = this.generateOrgId(organizationName);
      if (!orgId || orgId.length === 0) {
        throw new AppError(
          'Organisation name must contain at least one letter or number.',
          400,
          'INVALID_ORG_NAME'
        );
      }

      logInfo('Starting registration', { orgId, organizationName, organizationNameLength: organizationName?.length });

      // Check if this email is already registered in any tenant (one email = one account globally)
      const tenants = await routerModels.Tenant.find({ status: 'active' });
      for (const tenant of tenants) {
        try {
          const tenantDb = await getTenantConnection(tenant.orgId);
          const userRepo = new UserRepository(tenantDb);
          const existingUser = await userRepo.findByEmail(email);
          if (existingUser) {
            throw new AppError('This email is already registered. Please log in or use a different email.', 409, 'EMAIL_EXISTS');
          }
        } catch (err) {
          if (err instanceof AppError) throw err;
          logError('Failed to check email in tenant during registration', err, { orgId: tenant.orgId });
          continue;
        }
      }

      // Check if tenant (organisation) already exists by name (same orgId)
      const existingTenant = await routerModels.Tenant.findOne({ orgId: orgId.toLowerCase() });
      if (existingTenant && existingTenant.status === 'active') {
        throw new AppError('An organisation with this name already exists.', 409, 'ORG_EXISTS');
      }

      // Generate organization encryption key
      const orgKey = generateOrgKey();

      // Select Pod cluster (for now, use first Pod - will implement Pod selection later)
      const clusterEndpoint = process.env.POD_CLUSTER_ENDPOINT || process.env.ROUTER_DB_URI.replace('/router_db', '');
      const dbName = `org_${orgId}_v1`;

      logInfo('Registering tenant', { orgId, dbName });

      // Register tenant in Router DB
      try {
        await registerTenant({
          orgId,
          clusterEndpoint,
          dbName,
          orgKey
        });
        logInfo('Tenant registered successfully', { orgId });
      } catch (tenantError) {
        logError('Failed to register tenant', tenantError, { orgId });
        throw new AppError('Failed to create organization. Please try again.', 500, 'TENANT_CREATION_FAILED');
      }

      // Get tenant database connection
      const tenantDb = await getTenantConnection(orgId);
      const userRepo = new UserRepository(tenantDb);
      const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
      const orgRepo = new OrganizationRepository(tenantDb);

      // Create organization document if it doesn't exist
      let org = await orgRepo.findOne();
      if (!org) {
        org = await orgRepo.create({
          orgId: orgId,  // Store the normalized orgId
          name: organizationName,
          status: 'pending_setup'
        });
        logInfo('Organization created during registration', { orgId, orgName: organizationName });
      }

      // Check if user email exists in this tenant DB
      const existingUser = await userRepo.findByEmail(email);
      if (existingUser) {
        throw new AppError('Email already registered', 409, 'EMAIL_EXISTS');
      }

      // Hash password
      const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

      // Create user - email_hash will be set by mongoose plugin during save
      // This is the initial organisation owner, so mark as such
      const user = await userRepo.create({
        email,
        password_hash,
        first_name: firstName,
        last_name: lastName,
        status: 'active',
        is_org_owner: true
      });

      // Self-created: set created_by to own id for audit trail attribution
      try {
        await userRepo.update(user._id, { created_by: user._id });
      } catch (_) {
        // Non-blocking
      }
      
      // Verify email_hash was created
      if (!user.email_hash) {
        logError('email_hash not created during user registration', null, { userId: user._id, orgId });
        // Manually set email_hash as fallback
        const emailHash = userRepo.createEmailHash(email);
        await userRepo.update(user._id, { email_hash: emailHash });
        user.email_hash = emailHash;
      }

      // Re-fetch user to ensure decryption via post-find hook
      const decryptedUser = await userRepo.findById(user._id);
      const userObj = decryptUserFields(decryptedUser, getMasterKeyHex());
      
      // Normalize orgId to lowercase for consistency
      const normalizedOrgId = orgId.toLowerCase().trim();
      
      logInfo('User registered', { userId: userObj._id, orgId: normalizedOrgId });

      // Generate tokens with normalized orgId
      const token = generateToken({
        userId: userObj._id.toString(),
        orgId: normalizedOrgId,
        email: userObj.email || email,
        roles: ['admin'],
        permissions: ['*:*']
      });

      return {
        user: {
          id: userObj._id.toString(),
          email: userObj.email || email,
          firstName: userObj.first_name || firstName,
          lastName: userObj.last_name || lastName,
          role: 'admin',
          permissions: ['*:*'],
          is_org_owner: true,
          is_auditor: false
        },
        token,
        orgId: normalizedOrgId
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const orgId = this.generateOrgId(organizationName);
      logError('Registration failed', error, {
        email,
        organizationName: organizationName?.substring(0, 50),
        organizationNameLength: organizationName?.length,
        orgId: orgId || '(empty)',
        orgIdLength: orgId?.length ?? 0,
        cause: error?.message
      });
      const details =
        process.env.NODE_ENV === 'development' && error?.message
          ? { cause: error.message }
          : undefined;
      throw new AppError(
        'Registration failed. Please check organisation name (2–80 characters, must include a letter or number) and try again.',
        500,
        'REGISTRATION_ERROR',
        details
      );
    }
  }

  async login(email, password) {
    try {
      // Find tenant by checking user email across tenants
      // For MVP, we'll need to search Router DB for tenant
      // This is inefficient but works for now - optimize later with email index
      
      const routerModels = getRouterModels();
      const tenants = await routerModels.Tenant.find({ status: 'active' });

      let user = null;
      let tenantDb = null;
      let orgId = null;

      // Search each tenant DB for user
      for (const tenant of tenants) {
        try {
          tenantDb = await getTenantConnection(tenant.orgId);
          const userRepo = new UserRepository(tenantDb);
          
          // Debug: Log the hash we're searching for
          const searchHash = userRepo.createEmailHash(email);
          logInfo('Searching tenant for user', { orgId: tenant.orgId, emailHash: searchHash.substring(0, 8) + '...' });
          
          user = await userRepo.findByEmail(email);

          if (user) {
            orgId = tenant.orgId;
            logInfo('User candidate found for login', { orgId, userId: user._id, emailHash: user.email_hash?.substring(0, 8) + '...' });
            break;
          }
        } catch (error) {
          logError('Failed to search tenant for login', error, { orgId: tenant.orgId });
          continue;
        }
      }

      if (!user) {
        logWarn('Login failed - user not found in any tenant', { email });
        throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
      }

      // Check if user is locked
      if (user.locked && user.locked_until && new Date() < user.locked_until) {
        throw new AppError('Account is locked. Please try again later', 423, 'ACCOUNT_LOCKED');
      }

      // Verify password
      const isPasswordValid = await bcrypt.compare(password, user.password_hash);

      if (!isPasswordValid) {
        const userRepo = new UserRepository(tenantDb);
        await userRepo.incrementFailedAttempts(user._id);

        const updatedUser = await userRepo.findById(user._id);
        if (updatedUser.failed_login_attempts >= MAX_FAILED_ATTEMPTS) {
          const lockUntil = new Date(Date.now() + LOCK_DURATION_MS);
          await userRepo.lockUser(user._id, lockUntil);
          logWarn('Account locked due to failed attempts', { userId: user._id, orgId });
          throw new AppError('Account locked due to too many failed attempts', 423, 'ACCOUNT_LOCKED');
        }

        logWarn('Login failed - invalid password', { userId: user._id, orgId });
        throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
      }

      // Block login for any non-active account state.
      if (user.status && user.status !== 'active') {
        logWarn('Login blocked - user account not active', { userId: user._id, orgId, status: user.status });
        throw new AppError(
          'Your account is inactive. Please contact your administrator.',
          403,
          'ACCOUNT_INACTIVE'
        );
      }

      // Check if all of this user's positions have been transferred (auditors are not on the board)
      if (!user.is_org_owner && !user.is_auditor) {
        try {
          const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
          const bmRepo = new BoardMemberRepository(tenantDb);
          const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
          const orgRepo = new OrganizationRepository(tenantDb);
          const org = await orgRepo.findOne();
          if (org) {
            const BoardMemberModel = bmRepo.BoardMember;
            const allBmRecords = await BoardMemberModel.find({
              user_id: user._id,
              org_id: org._id
            }).lean();
            const hasActive = allBmRecords.some(bm => bm.is_active && bm.status !== 'transferred');
            const hasTransferred = allBmRecords.some(bm => bm.status === 'transferred');
            if (allBmRecords.length > 0 && !hasActive && hasTransferred) {
              logWarn('Login blocked - all positions transferred', { userId: user._id, orgId });
              throw new AppError(
                'Your position has been transferred to another person as part of a Business Continuity transfer. Please contact your administrator.',
                403,
                'POSITION_TRANSFERRED'
              );
            }
          }
        } catch (err) {
          if (err.code === 'POSITION_TRANSFERRED') throw err;
          logError('Error checking transfer status during login', err, { userId: user._id });
        }
      }

      // Update last login
      const userRepo = new UserRepository(tenantDb);
      await userRepo.updateLastLogin(user._id);

      // Normalize orgId to lowercase for consistency (needed for both MFA and non-MFA paths)
      const normalizedOrgId = orgId.toLowerCase().trim();

      // Auditors: view-only token, no MFA branch
      if (user.is_auditor) {
        const decryptedUser = await userRepo.findById(user._id);
        const rawUserAud = decryptedUser.toObject ? decryptedUser.toObject() : decryptedUser;
        const masterKeyHexAud = getMasterKeyHex();
        if (!masterKeyHexAud) {
          throw new AppError('Encryption key not available', 500, 'ENCRYPTION_ERROR');
        }
        const userObjAud = decryptUserFields(rawUserAud, masterKeyHexAud);
        if (rawUserAud.email && isEncrypted(rawUserAud.email) && !userObjAud.email) {
          userObjAud.email = email;
        }
        const auditorPerms = buildAuditorPermissions();
        const token = generateToken({
          userId: userObjAud._id.toString(),
          orgId: normalizedOrgId,
          email: userObjAud.email || email,
          roles: ['auditor'],
          permissions: auditorPerms,
          isAuditor: true
        });
        logInfo('Auditor logged in', { userId: userObjAud._id, orgId: normalizedOrgId });
        return {
          user: {
            id: userObjAud._id.toString(),
            email: userObjAud.email || email,
            firstName: userObjAud.first_name || '',
            lastName: userObjAud.last_name || '',
            role: 'auditor',
            permissions: auditorPerms,
            is_board_member: false,
            is_auditor: true,
            is_org_owner: false,
            position: 'Auditor',
            positions: [{ id: null, title: 'Auditor' }]
          },
          token,
          orgId: normalizedOrgId
        };
      }

      // Check if MFA is enabled
      if (MFA_LOGIN_ENABLED && user.mfa_enabled) {
        // Send OTP and return flag for frontend to redirect to OTP verification
        try {
          await this.sendOtpEmail(tenantDb, user);
          
          // Re-fetch user to ensure decryption via post-find hook for needs_otp response
          const decryptedUser = await userRepo.findById(user._id);
          const rawUser = decryptedUser.toObject ? decryptedUser.toObject() : decryptedUser;
          const masterKeyHex = getMasterKeyHex();
          const userObj = decryptUserFields(rawUser, masterKeyHex);
          if (rawUser.email && isEncrypted(rawUser.email) && !userObj.email) {
            userObj.email = email;
          }

          // Get org for permissions
          const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
          const orgRepo = new OrganizationRepository(tenantDb);
          const org = await orgRepo.findOne();
          const positionPermissions = org ? await getPositionPermissionsForUser(tenantDb, userObj._id, org._id) : [];

          let baseRoles;
          let basePermissions;

          if (userObj.is_org_owner) {
            baseRoles = ['admin'];
            basePermissions = ['*:*'];
          } else if (positionPermissions.length > 0) {
            baseRoles = ['board_member'];
            basePermissions = ['read:own', 'write:own', ...positionPermissions];
          } else {
            baseRoles = ['board_member'];
            basePermissions = ['read:own', 'write:own'];
          }

          // Format user for frontend (similar to non-MFA login response)
          const userForFrontend = {
            _id: userObj._id?.toString(),
            firstName: userObj.first_name,
            lastName: userObj.last_name,
            email: userObj.email,
            roles: baseRoles,
            permissions: basePermissions,
            mfa_enabled: userObj.mfa_enabled,
            is_org_owner: !!userObj.is_org_owner,
            is_auditor: !!userObj.is_auditor
          };

          return {
            success: true,
            needs_otp: true,
            user_id: user._id.toString(),
            user: userForFrontend,
            orgId: normalizedOrgId
          };
        } catch (otpErr) {
          logError('Failed to send OTP during login', otpErr, { userId: user._id, orgId });
          throw new AppError('Failed to send verification code. Please try again.', 500, 'OTP_SEND_FAILED');
        }
      }

      // Re-fetch user to ensure decryption via post-find hook
      const decryptedUser = await userRepo.findById(user._id);
      const rawUser = decryptedUser.toObject ? decryptedUser.toObject() : decryptedUser;
      const masterKeyHex = getMasterKeyHex();
      if (!masterKeyHex) {
        throw new AppError('Encryption key not available', 500, 'ENCRYPTION_ERROR');
      }
      const userObj = decryptUserFields(rawUser, masterKeyHex);
      if (rawUser.email && isEncrypted(rawUser.email) && !userObj.email) {
        userObj.email = email;
      }

      const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
      const orgRepo = new OrganizationRepository(tenantDb);
      const org = await orgRepo.findOne();

      // Load permissions from user's position (if they are a board member with position_id)
      const positionPermissions = org ? await getPositionPermissionsForUser(tenantDb, userObj._id, org._id) : [];

      // Determine roles & permissions:
      // - Org owner (is_org_owner) => full admin, *:*
      // - Board/committee members with a position => board_member + their granted permissions
      // - Other users (no position) => basic board_member with read/write own only
      let baseRoles;
      let basePermissions;

      if (userObj.is_org_owner) {
        baseRoles = ['admin'];
        basePermissions = ['*:*'];
      } else if (positionPermissions.length > 0) {
        baseRoles = ['board_member'];
        basePermissions = ['read:own', 'write:own', ...positionPermissions];
      } else {
        baseRoles = ['board_member'];
        basePermissions = ['read:own', 'write:own'];
      }

      const token = generateToken({
        userId: userObj._id.toString(),
        orgId: normalizedOrgId,
        email: userObj.email || email,
        roles: baseRoles,
        permissions: basePermissions,
        isAuditor: false
      });

      logInfo('User logged in', { userId: userObj._id, orgId: normalizedOrgId });

      const responseUser = {
        id: userObj._id.toString(),
        email: userObj.email || email,
        firstName: userObj.first_name || '',
        lastName: userObj.last_name || '',
        role: baseRoles[0] || 'board_member',
        permissions: basePermissions,
        is_board_member: false,
        is_auditor: false,
        is_org_owner: !!userObj.is_org_owner
      };

      const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
      const boardMemberRepo = new BoardMemberRepository(tenantDb);

      // Get ALL active board_member records (user may hold multiple positions after BCP transfer)
      const allBoardMembers = await boardMemberRepo.findAllActiveByUserId(userObj._id, org._id);
      const { userHoldsBoardLevelPosition } = await import('../utils/workflowBoardMember.js');
      responseUser.is_board_member = await userHoldsBoardLevelPosition(tenantDb, userObj._id, org._id);
      if (allBoardMembers && allBoardMembers.length > 0) {
        // Primary position = first record (original position)
        const primaryBm = allBoardMembers[0];
        responseUser.position = primaryBm.custom_position_title || primaryBm.position || null;

        // All positions array for sidebar display
        responseUser.positions = allBoardMembers.map(bm => ({
          id: bm.position_id?.toString?.() || bm.position_id,
          title: bm.custom_position_title || bm.position || 'Position'
        }));

        // Profile picture from any board_member that has one
        const bmWithPic = allBoardMembers.find(bm => bm.profile_picture_key);
        if (bmWithPic) {
          try {
            const { getFileUrl } = await import('../services/s3Service.js');
            responseUser.profile_picture_url = await getFileUrl(bmWithPic.profile_picture_key, 604800);
          } catch (err) {
            logError('Failed to resolve profile picture URL', err, { userId: userObj._id });
          }
        }
      } else if (userObj.is_org_owner) {
        responseUser.position = 'Admin';
        responseUser.positions = [{ id: null, title: 'Admin' }];
        const userProfileKey = rawUser.profile_picture_key;
        if (userProfileKey) {
          try {
            const { getFileUrl } = await import('../services/s3Service.js');
            responseUser.profile_picture_url = await getFileUrl(userProfileKey, 604800);
          } catch (err) {
            logError('Failed to resolve profile picture URL for org owner', err, { userId: userObj._id });
          }
        }
      }

      return {
        user: responseUser,
        token,
        orgId: normalizedOrgId
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logError('Login failed', error, { email });
      throw new AppError('Login failed', 500, 'LOGIN_ERROR');
    }
  }

  generateOrgId(organizationName) {
    return organizationName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 50);
  }

  async verifyInvitationToken(token) {
    try {
      const routerModels = getRouterModels();
      const tenants = await routerModels.Tenant.find({ status: 'active' });

      // Search each tenant DB for the invitation token. Two flavours of
      // invitation exist: BoardMember invites (positioned staff/volunteers)
      // and auditor_invites (read-only auditors). Check both per tenant.
      for (const tenant of tenants) {
        try {
          const tenantDb = await getTenantConnection(tenant.orgId);
          const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
          const boardMemberRepo = new BoardMemberRepository(tenantDb);

          const boardMember = await boardMemberRepo.findByInvitationToken(token);

          if (boardMember) {
            // Check if already accepted
            if (boardMember.invitation_status === 'accepted') {
              throw new AppError('Invitation has already been accepted', 409, 'INVITATION_ALREADY_ACCEPTED');
            }

            // Get organization name
            const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
            const orgRepo = new OrganizationRepository(tenantDb);
            const org = await orgRepo.findOne();

            return {
              valid: true,
              kind: 'board_member',
              boardMember: {
                id: boardMember._id.toString(),
                email: boardMember.email,
                givenNames: boardMember.given_names,
                familyName: boardMember.family_name,
                position: boardMember.custom_position_title || boardMember.position
              },
              organization: {
                id: org?._id?.toString(),
                name: org?.name || 'Organization'
              },
              orgId: tenant.orgId
            };
          }

          // Auditor invite check.
          const auditorInvite = await tenantDb
            .collection('auditor_invites')
            .findOne({ invitation_token: token });
          if (auditorInvite) {
            if (auditorInvite.invitation_status === 'accepted') {
              throw new AppError('Invitation has already been accepted', 409, 'INVITATION_ALREADY_ACCEPTED');
            }
            if (auditorInvite.invitation_expires_at && new Date(auditorInvite.invitation_expires_at) < new Date()) {
              throw new AppError('Invitation has expired', 410, 'INVITATION_EXPIRED');
            }
            const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
            const orgRepo = new OrganizationRepository(tenantDb);
            const org = await orgRepo.findOne();
            return {
              valid: true,
              kind: 'auditor',
              auditor: {
                id: auditorInvite._id.toString(),
                email: auditorInvite.email,
                firstName: auditorInvite.firstName || '',
                lastName: auditorInvite.lastName || ''
              },
              // Mirror the boardMember shape so the existing accept-invitation
              // page can render the recipient + org without branching.
              boardMember: {
                id: auditorInvite._id.toString(),
                email: auditorInvite.email,
                givenNames: auditorInvite.firstName || '',
                familyName: auditorInvite.lastName || '',
                position: 'Auditor'
              },
              organization: {
                id: org?._id?.toString(),
                name: org?.name || 'Organization'
              },
              orgId: tenant.orgId
            };
          }
        } catch (error) {
          if (error instanceof AppError) {
            throw error;
          }
          logError('Failed to search tenant for invitation token', error, { orgId: tenant.orgId });
          continue;
        }
      }

      throw new AppError('Invalid invitation token', 404, 'INVALID_TOKEN');
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logError('Failed to verify invitation token', error);
      throw new AppError('Failed to verify invitation', 500, 'VERIFICATION_ERROR');
    }
  }

  async acceptInvitation(token, password) {
    try {
      // First verify the token
      const tokenInfo = await this.verifyInvitationToken(token);

      const tenantDb = await getTenantConnection(tokenInfo.orgId);
      const userRepo = new UserRepository(tenantDb);

      // ---- Auditor invite branch ----
      // Auditors don't have a BoardMember record — create the User with
      // `is_auditor: true`, mark the auditor_invite as accepted, and return
      // an auditor-scoped JWT.
      if (tokenInfo.kind === 'auditor') {
        const auditorInvite = await tenantDb
          .collection('auditor_invites')
          .findOne({ invitation_token: token });
        if (!auditorInvite) {
          throw new AppError('Invalid invitation token', 404, 'INVALID_TOKEN');
        }

        const existing = await userRepo.findByEmail(auditorInvite.email);
        let user;
        if (existing) {
          await userRepo.update(existing._id, { is_auditor: true, status: 'active' });
          user = { ...(existing.toObject ? existing.toObject() : existing), is_auditor: true };
        } else {
          const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
          user = await userRepo.create({
            email: auditorInvite.email,
            password_hash,
            first_name: auditorInvite.firstName || '',
            last_name: auditorInvite.lastName || '',
            status: 'active',
            is_auditor: true
          });
          try {
            await userRepo.update(user._id, { created_by: user._id });
          } catch (_) {
            // Non-blocking
          }
        }

        await tenantDb.collection('auditor_invites').updateOne(
          { _id: auditorInvite._id },
          { $set: {
            invitation_status: 'accepted',
            invitation_accepted_at: new Date(),
            invitation_token: null,
            user_id: user._id
          } }
        );

        const normalizedOrgId = tokenInfo.orgId.toLowerCase().trim();
        const auditorPerms = buildAuditorPermissions();
        const authToken = generateToken({
          userId: user._id.toString(),
          orgId: normalizedOrgId,
          email: auditorInvite.email,
          roles: ['auditor'],
          permissions: auditorPerms,
          isAuditor: true
        });

        logInfo('Auditor invitation accepted', { userId: user._id, orgId: normalizedOrgId });

        return {
          user: {
            id: user._id.toString(),
            email: auditorInvite.email,
            firstName: auditorInvite.firstName || '',
            lastName: auditorInvite.lastName || '',
            role: 'auditor',
            permissions: auditorPerms,
            is_board_member: false,
            is_auditor: true,
            is_org_owner: false,
            position: 'Auditor',
            positions: [{ id: null, title: 'Auditor' }]
          },
          token: authToken,
          orgId: normalizedOrgId
        };
      }

      // ---- Board member invite branch (existing flow) ----
      const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
      const boardMemberRepo = new BoardMemberRepository(tenantDb);

      const boardMember = await boardMemberRepo.findByInvitationToken(token);
      if (!boardMember) {
        throw new AppError('Invalid invitation token', 404, 'INVALID_TOKEN');
      }

      // Check if user with this email already exists
      const existingUser = await userRepo.findByEmail(boardMember.email);
      if (existingUser) {
        // Link existing user to board member
        await boardMemberRepo.update(boardMember._id, {
          user_id: existingUser._id,
          invitation_status: 'accepted',
          invitation_accepted_at: new Date(),
          invitation_token: null
        });

        logInfo('Board member linked to existing user', {
          boardMemberId: boardMember._id,
          userId: existingUser._id,
          orgId: tokenInfo.orgId
        });

        const normalizedOrgId = tokenInfo.orgId.toLowerCase().trim();
        const positionPermissions = await getPositionPermissionsForUser(tenantDb, existingUser._id, boardMember.org_id);
        const permissions = ['read:own', 'write:own', ...positionPermissions];

        const token = generateToken({
          userId: existingUser._id.toString(),
          orgId: normalizedOrgId,
          email: boardMember.email,
          roles: ['board_member'],
          permissions
        });

        const { userHoldsBoardLevelPosition } = await import('../utils/workflowBoardMember.js');
        const user = {
          id: existingUser._id.toString(),
          email: boardMember.email,
          firstName: boardMember.given_names,
          lastName: boardMember.family_name,
          role: 'board_member',
          permissions,
          is_board_member: await userHoldsBoardLevelPosition(tenantDb, existingUser._id, boardMember.org_id),
          is_org_owner: !!existingUser.is_org_owner,
          is_auditor: !!existingUser.is_auditor
        };
        user.position = boardMember.custom_position_title || boardMember.position || null;
        if (boardMember.profile_picture_key) {
          try {
            const { getFileUrl } = await import('../services/s3Service.js');
            user.profile_picture_url = await getFileUrl(boardMember.profile_picture_key, 604800);
          } catch (err) {
            logError('Failed to resolve profile picture URL', err, { userId: existingUser._id });
          }
        }
        return { user, token, orgId: normalizedOrgId };
      }

      // Create new user
      const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

      const newUser = await userRepo.create({
        email: boardMember.email,
        password_hash,
        first_name: boardMember.given_names,
        last_name: boardMember.family_name,
        status: 'active'
      });

      // Self-created via invitation acceptance: set created_by to own id
      try {
        await userRepo.update(newUser._id, { created_by: newUser._id });
      } catch (_) {
        // Non-blocking
      }

      // Link user to board member and mark invitation as accepted
      await boardMemberRepo.update(boardMember._id, {
        user_id: newUser._id,
        invitation_status: 'accepted',
        invitation_accepted_at: new Date(),
        invitation_token: null
      });

      logInfo('Board member invitation accepted', {
        boardMemberId: boardMember._id,
        userId: newUser._id,
        orgId: tokenInfo.orgId
      });

      const normalizedOrgId = tokenInfo.orgId.toLowerCase().trim();
      const positionPermissions = await getPositionPermissionsForUser(tenantDb, newUser._id, boardMember.org_id);
      const permissions = ['read:own', 'write:own', ...positionPermissions];

      const authToken = generateToken({
        userId: newUser._id.toString(),
        orgId: normalizedOrgId,
        email: boardMember.email,
        roles: ['board_member'],
        permissions
      });

      const { userHoldsBoardLevelPosition: holdsBoardLevel } = await import('../utils/workflowBoardMember.js');
      const user = {
        id: newUser._id.toString(),
        email: boardMember.email,
        firstName: boardMember.given_names,
        lastName: boardMember.family_name,
        role: 'board_member',
        permissions,
        is_board_member: await holdsBoardLevel(tenantDb, newUser._id, boardMember.org_id),
        is_org_owner: false,
        is_auditor: false
      };
      user.position = boardMember.custom_position_title || boardMember.position || null;
      if (boardMember.profile_picture_key) {
        try {
          const { getFileUrl } = await import('../services/s3Service.js');
          user.profile_picture_url = await getFileUrl(boardMember.profile_picture_key, 604800);
        } catch (err) {
          logError('Failed to resolve profile picture URL', err, { userId: newUser._id });
        }
      }
      return { user, token: authToken, orgId: normalizedOrgId };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logError('Failed to accept invitation', error);
      throw new AppError('Failed to accept invitation', 500, 'ACCEPT_INVITATION_ERROR');
    }
  }

  /**
   * Request password reset - sends email with reset link
   */
  async forgotPassword(email) {
    const routerModels = getRouterModels();
    const tenants = await routerModels.Tenant.find({ status: 'active' });

    let user = null;
    let tenantDb = null;

    for (const tenant of tenants) {
      try {
        tenantDb = await getTenantConnection(tenant.orgId);
        const userRepo = new UserRepository(tenantDb);
        user = await userRepo.findByEmail(email);
        if (user) break;
      } catch (err) {
        logError('Failed to search tenant for forgot password', err, { orgId: tenant.orgId });
        continue;
      }
    }

    if (!user) {
      logWarn('Forgot password - user not found', { email });
      return; // Don't reveal if email exists
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    const userRepo = new UserRepository(tenantDb);
    await userRepo.update(user._id, {
      password_reset_token: resetToken,
      password_reset_expires: expiresAt
    });

    const masterKeyHex = getMasterKeyHex();
    const rawUser = user.toObject ? user.toObject() : { ...user };
    const decrypted = decryptUserFields(rawUser, masterKeyHex);
    const recipientName = [decrypted.first_name, decrypted.last_name].filter(Boolean).join(' ') || 'there';
    const recipientEmail = decrypted.email || email;

    try {
      await emailService.sendPasswordResetEmail({
        to: recipientEmail,
        recipientName,
        resetToken
      });
      logInfo('Password reset email sent', { email: recipientEmail });
    } catch (emailErr) {
      logError('Failed to send password reset email', emailErr, { email: recipientEmail });
      throw new AppError('Failed to send reset email. Please try again.', 500, 'EMAIL_SEND_FAILED');
    }
  }

  /**
   * Validate a password-reset token without consuming it. Used by the
   * reset-password page on load so we can show "Invalid Reset Link" instead
   * of the form when the token is missing, garbled, or expired.
   *
   * Returns { valid: true } on success, or throws INVALID_RESET_TOKEN.
   */
  async verifyResetToken(token) {
    if (!token || typeof token !== 'string') {
      throw new AppError('Invalid or expired reset link. Please request a new one.', 400, 'INVALID_RESET_TOKEN');
    }

    const routerModels = getRouterModels();
    const tenants = await routerModels.Tenant.find({ status: 'active' });

    for (const tenant of tenants) {
      try {
        const tenantDb = await getTenantConnection(tenant.orgId);
        const userRepo = new UserRepository(tenantDb);
        const user = await userRepo.findByResetToken(token);
        if (user) {
          return { valid: true };
        }
      } catch (err) {
        logError('Failed to search tenant for verify-reset-token', err, { orgId: tenant.orgId });
        continue;
      }
    }

    throw new AppError('Invalid or expired reset link. Please request a new one.', 400, 'INVALID_RESET_TOKEN');
  }

  /**
   * Reset password using token from email
   */
  async resetPassword(token, newPassword) {
    const routerModels = getRouterModels();
    const tenants = await routerModels.Tenant.find({ status: 'active' });

    let user = null;
    let tenantDb = null;

    for (const tenant of tenants) {
      try {
        tenantDb = await getTenantConnection(tenant.orgId);
        const userRepo = new UserRepository(tenantDb);
        user = await userRepo.findByResetToken(token);
        if (user) break;
      } catch (err) {
        logError('Failed to search tenant for reset password', err, { orgId: tenant.orgId });
        continue;
      }
    }

    if (!user) {
      throw new AppError('Invalid or expired reset link. Please request a new one.', 400, 'INVALID_RESET_TOKEN');
    }

    const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    const userRepo = new UserRepository(tenantDb);
    await userRepo.update(user._id, {
      password_hash,
      password_reset_token: null,
      password_reset_expires: null
    });

    logInfo('Password reset successful', { userId: user._id });
    return { success: true };
  }

  /**
   * Generate the OTP code.
   *
   * TEMPORARY (development / demo): always returns the fixed 4-digit
   * code "1743" so QA + sales demos don't need email delivery to log
   * in. Revert to a random 4-/6-digit generator before production.
   *
   * @returns {string} fixed code
   */
  generateOtpCode() {
    return '1743';
  }

  /**
   * Send OTP email to user
   * @param {Object} tenantDb - Tenant database connection
   * @param {Object} user - User object
   * @returns {Promise<string>} Generated OTP code
   */
  async sendOtpEmail(tenantDb, user) {
    const { OtpRepository } = await import('../repositories/otpRepository.js');
    const otpRepo = new OtpRepository(tenantDb);

    // Generate OTP code
    const code = this.generateOtpCode();

    // Store OTP in database
    await otpRepo.create(user._id.toString(), user.email, code);

    // Get decrypted user info for email
    const masterKeyHex = getMasterKeyHex();
    const rawUser = user.toObject ? user.toObject() : { ...user };
    const decrypted = decryptUserFields(rawUser, masterKeyHex);
    const recipientName = [decrypted.first_name, decrypted.last_name].filter(Boolean).join(' ') || 'there';
    const recipientEmail = decrypted.email || user.email;

    // Send OTP email
    try {
      await emailService.sendOtpEmail({
        to: recipientEmail,
        recipientName,
        code
      });
      logInfo('OTP email sent', { userId: user._id, email: recipientEmail });
    } catch (emailErr) {
      logError('Failed to send OTP email', emailErr, { userId: user._id });
      if (process.env.NODE_ENV !== 'production') {
        logInfo('[DEV] OTP code (SMTP failed - use this to login)', { code, email: recipientEmail });
      } else {
        throw new AppError('Failed to send OTP code. Please try again.', 500, 'OTP_SEND_FAILED');
      }
    }

    return code;
  }

  /**
   * Verify OTP code
   * @param {Object} tenantDb - Tenant database connection
   * @param {string} userId - User ID
   * @param {string} code - OTP code to verify
   * @returns {Promise<boolean>} True if OTP is valid
   */
  async verifyOtp(tenantDb, userId, code) {
    const { OtpRepository } = await import('../repositories/otpRepository.js');
    const otpRepo = new OtpRepository(tenantDb);

    // TEMPORARY (development / demo): the generator always returns the
    // fixed code "1743". Accept it for any user without consulting the
    // OtpRepository so demos and QA tests don't depend on email
    // delivery or DB state. Revert when re-enabling real OTP.
    if (String(code) === '1743') {
      // Best-effort cleanup of any stored OTPs for this user.
      const stored = await otpRepo.findByUserIdAndCode(userId, '1743').catch(() => null);
      if (stored?._id) {
        await otpRepo.deleteById(stored._id).catch(() => {});
      }
      return true;
    }

    // Fallback to the real flow for any non-bypass code (so a future
    // production switch only requires reverting `generateOtpCode` and
    // removing the bypass above).
    const otp = await otpRepo.findByUserIdAndCode(userId, code);

    if (!otp) {
      throw new AppError('Invalid OTP code', 400, 'INVALID_OTP');
    }

    if (otp.attempts >= 3) {
      await otpRepo.deleteById(otp._id);
      throw new AppError('Too many failed attempts. Please request a new code.', 400, 'OTP_MAX_ATTEMPTS');
    }

    await otpRepo.deleteById(otp._id);

    return true;
  }

  /**
   * Complete login after OTP verification - returns token, user, orgId
   */
  async completeLoginWithOtp(orgId, userId, code) {
    const normalizedOrgId = (orgId || '').toLowerCase().trim();
    if (!normalizedOrgId) {
      throw new AppError('Organization ID is required', 400, 'MISSING_ORG_ID');
    }

    const tenantDb = await getTenantConnection(normalizedOrgId);
    await this.verifyOtp(tenantDb, userId, code);

    const userRepo = new UserRepository(tenantDb);
    const user = await userRepo.findById(userId);
    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    const rawUser = user.toObject ? user.toObject() : { ...user };
    const masterKeyHex = getMasterKeyHex();
    const userObj = decryptUserFields(rawUser, masterKeyHex);
    if (rawUser.email && isEncrypted(rawUser.email) && !userObj.email) {
      userObj.email = rawUser.email;
    }

    const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();

    if (userObj.is_auditor) {
      const auditorPerms = buildAuditorPermissions();
      const token = generateToken({
        userId: userObj._id.toString(),
        orgId: normalizedOrgId,
        email: userObj.email,
        roles: ['auditor'],
        permissions: auditorPerms,
        isAuditor: true
      });
      const responseUser = {
        id: userObj._id.toString(),
        email: userObj.email || '',
        firstName: userObj.first_name || '',
        lastName: userObj.last_name || '',
        role: 'auditor',
        permissions: auditorPerms,
        is_board_member: false,
        is_auditor: true,
        is_org_owner: false,
        position: 'Auditor',
        positions: [{ id: null, title: 'Auditor' }]
      };
      return {
        token,
        user: responseUser,
        orgId: normalizedOrgId,
        user_id: userObj._id.toString()
      };
    }

    const positionPermissions = org ? await getPositionPermissionsForUser(tenantDb, userObj._id, org._id) : [];

    let baseRoles;
    let basePermissions;
    if (userObj.is_org_owner) {
      baseRoles = ['admin'];
      basePermissions = ['*:*'];
    } else if (positionPermissions.length > 0) {
      baseRoles = ['board_member'];
      basePermissions = ['read:own', 'write:own', ...positionPermissions];
    } else {
      baseRoles = ['board_member'];
      basePermissions = ['read:own', 'write:own'];
    }

    const token = generateToken({
      userId: userObj._id.toString(),
      orgId: normalizedOrgId,
      email: userObj.email,
      roles: baseRoles,
      permissions: basePermissions,
      isAuditor: false
    });

    const responseUser = {
      id: userObj._id.toString(),
      email: userObj.email || '',
      firstName: userObj.first_name || '',
      lastName: userObj.last_name || '',
      role: baseRoles[0] || 'board_member',
      permissions: basePermissions,
      is_board_member: false,
      is_auditor: false,
      is_org_owner: !!userObj.is_org_owner
    };

    const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
    const boardMemberRepo = new BoardMemberRepository(tenantDb);
    const { userHoldsBoardLevelPosition } = await import('../utils/workflowBoardMember.js');
    responseUser.is_board_member = await userHoldsBoardLevelPosition(tenantDb, userObj._id, org._id);
    const boardMember = await boardMemberRepo.findByUserId(userObj._id, org._id);
    if (boardMember) {
      responseUser.position = boardMember.custom_position_title || boardMember.position || null;
      if (boardMember.profile_picture_key) {
        try {
          const { getFileUrl } = await import('../services/s3Service.js');
          responseUser.profile_picture_url = await getFileUrl(boardMember.profile_picture_key, 604800);
        } catch (err) {
          logError('Failed to resolve profile picture URL', err, { userId: userObj._id });
        }
      }
    } else if (userObj.is_org_owner) {
      responseUser.position = 'Admin';
      const userProfileKey = rawUser.profile_picture_key;
      if (userProfileKey) {
        try {
          const { getFileUrl } = await import('../services/s3Service.js');
          responseUser.profile_picture_url = await getFileUrl(userProfileKey, 604800);
        } catch (err) {
          logError('Failed to resolve profile picture URL for org owner', err, { userId: userObj._id });
        }
      }
    }

    return {
      token,
      user: responseUser,
      orgId: normalizedOrgId,
      user_id: userObj._id.toString()
    };
  }

  /**
   * Resend OTP to user (during login flow)
   */
  async resendOtp(orgId, userId) {
    const normalizedOrgId = (orgId || '').toLowerCase().trim();
    if (!normalizedOrgId) {
      throw new AppError('Organization ID is required', 400, 'MISSING_ORG_ID');
    }

    const tenantDb = await getTenantConnection(normalizedOrgId);
    const userRepo = new UserRepository(tenantDb);
    const user = await userRepo.findById(userId);
    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    await this.sendOtpEmail(tenantDb, user);
    return { success: true, message: 'New code sent' };
  }

  /**
   * Enable MFA for user
   * @param {Object} tenantDb - Tenant database connection
   * @param {string} userId - User ID
   * @returns {Promise<void>}
   */
  async enableMfa(tenantDb, userId) {
    const userRepo = new UserRepository(tenantDb);
    await userRepo.update(userId, { mfa_enabled: true });
    logInfo('MFA enabled for user', { userId });
  }

  /**
   * Disable MFA for user
   * @param {Object} tenantDb - Tenant database connection
   * @param {string} userId - User ID
   * @returns {Promise<void>}
   */
  async disableMfa(tenantDb, userId) {
    const { OtpRepository } = await import('../repositories/otpRepository.js');
    const userRepo = new UserRepository(tenantDb);
    const otpRepo = new OtpRepository(tenantDb);

    // Clean up any pending OTPs
    await otpRepo.deleteByUserId(userId);

    // Disable MFA
    await userRepo.update(userId, { mfa_enabled: false });
    logInfo('MFA disabled for user', { userId });
  }

  /**
   * Demo Portal: log in as another user without a password. Hard-gated to a
   * single tenant via DEMO_ORG_ID env var so the endpoint is a no-op anywhere
   * else. Used to demo the platform to consultants by swapping between users.
   */
  async loginAsDemoUser(callerOrgId, targetUserId) {
    const demoOrgId = String(process.env.DEMO_ORG_ID || '').trim().toLowerCase();
    if (!demoOrgId) {
      throw new AppError('Demo portal is not configured', 403, 'DEMO_NOT_CONFIGURED');
    }
    const normalizedOrgId = String(callerOrgId || '').trim().toLowerCase();
    if (normalizedOrgId !== demoOrgId) {
      // Log the exact values so the operator can see the mismatch in BE logs.
      logWarn('Demo login rejected — orgId mismatch', {
        envDemoOrgId: demoOrgId,
        envDemoOrgIdLength: demoOrgId.length,
        callerOrgId: normalizedOrgId,
        callerOrgIdLength: normalizedOrgId.length
      });
      throw new AppError('Demo login is only available on the demo portal', 403, 'NOT_DEMO_TENANT');
    }
    if (!targetUserId) {
      throw new AppError('Target user is required', 400, 'TARGET_USER_REQUIRED');
    }

    try {
      const tenantDb = await getTenantConnection(normalizedOrgId);
      const userRepo = new UserRepository(tenantDb);
      const target = await userRepo.findById(targetUserId);
      if (!target) {
        throw new AppError('Target user not found', 404, 'USER_NOT_FOUND');
      }
      if (target.status && target.status !== 'active') {
        throw new AppError('Target account is inactive', 403, 'ACCOUNT_INACTIVE');
      }

      const rawUser = target.toObject ? target.toObject() : target;
      const masterKeyHex = getMasterKeyHex();
      if (!masterKeyHex) {
        throw new AppError('Encryption key not available', 500, 'ENCRYPTION_ERROR');
      }
      const userObj = decryptUserFields(rawUser, masterKeyHex);

      // Auditor branch — issue a read-only auditor token.
      if (userObj.is_auditor) {
        const auditorPerms = buildAuditorPermissions();
        const token = generateToken({
          userId: userObj._id.toString(),
          orgId: normalizedOrgId,
          email: userObj.email || '',
          roles: ['auditor'],
          permissions: auditorPerms,
          isAuditor: true
        });
        return {
          user: {
            id: userObj._id.toString(),
            email: userObj.email || '',
            firstName: userObj.first_name || '',
            lastName: userObj.last_name || '',
            role: 'auditor',
            permissions: auditorPerms,
            is_board_member: false,
            is_auditor: true,
            is_org_owner: false,
            position: 'Auditor',
            positions: [{ id: null, title: 'Auditor' }]
          },
          token,
          orgId: normalizedOrgId
        };
      }

      const { OrganizationRepository } = await import('../repositories/organizationRepository.js');
      const orgRepo = new OrganizationRepository(tenantDb);
      const org = await orgRepo.findOne();
      const positionPermissions = org
        ? await getPositionPermissionsForUser(tenantDb, userObj._id, org._id)
        : [];

      let baseRoles;
      let basePermissions;
      if (userObj.is_org_owner) {
        baseRoles = ['admin'];
        basePermissions = ['*:*'];
      } else if (positionPermissions.length > 0) {
        baseRoles = ['board_member'];
        basePermissions = ['read:own', 'write:own', ...positionPermissions];
      } else {
        baseRoles = ['board_member'];
        basePermissions = ['read:own', 'write:own'];
      }

      const token = generateToken({
        userId: userObj._id.toString(),
        orgId: normalizedOrgId,
        email: userObj.email || '',
        roles: baseRoles,
        permissions: basePermissions,
        isAuditor: false
      });

      const responseUser = {
        id: userObj._id.toString(),
        email: userObj.email || '',
        firstName: userObj.first_name || '',
        lastName: userObj.last_name || '',
        role: baseRoles[0] || 'board_member',
        permissions: basePermissions,
        is_board_member: false,
        is_auditor: false,
        is_org_owner: !!userObj.is_org_owner
      };

      const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
      const boardMemberRepo = new BoardMemberRepository(tenantDb);
      if (org) {
        const allBoardMembers = await boardMemberRepo.findAllActiveByUserId(userObj._id, org._id);
        const { userHoldsBoardLevelPosition } = await import('../utils/workflowBoardMember.js');
        responseUser.is_board_member = await userHoldsBoardLevelPosition(tenantDb, userObj._id, org._id);
        if (allBoardMembers && allBoardMembers.length > 0) {
          const primaryBm = allBoardMembers[0];
          responseUser.position = primaryBm.custom_position_title || primaryBm.position || null;
          responseUser.positions = allBoardMembers.map((bm) => ({
            id: bm.position_id?.toString?.() || bm.position_id,
            title: bm.custom_position_title || bm.position || 'Position'
          }));
          const bmWithPic = allBoardMembers.find((bm) => bm.profile_picture_key);
          if (bmWithPic) {
            try {
              const { getFileUrl } = await import('../services/s3Service.js');
              responseUser.profile_picture_url = await getFileUrl(bmWithPic.profile_picture_key, 604800);
            } catch (err) {
              logError('Failed to resolve profile picture URL (demo)', err, { userId: userObj._id });
            }
          }
        } else if (userObj.is_org_owner) {
          responseUser.position = 'Admin';
          responseUser.positions = [{ id: null, title: 'Admin' }];
        }
      }

      logInfo('Demo portal: logged in as user', { targetUserId: userObj._id, orgId: normalizedOrgId });

      return { user: responseUser, token, orgId: normalizedOrgId };
    } catch (error) {
      if (error instanceof AppError) throw error;
      logError('Demo login failed', error, { targetUserId, orgId: callerOrgId });
      throw new AppError('Demo login failed', 500, 'DEMO_LOGIN_ERROR');
    }
  }
}

export default new AuthService();
