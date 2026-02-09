/**
 * Authentication Service
 * 
 * Business logic for authentication operations
 */

import bcrypt from 'bcryptjs';
import { generateToken } from '../middleware/auth.js';
import { generateOrgKey, getMasterKeyHex } from '../config/encryption.js';
import { registerTenant } from '../db/router.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { UserRepository } from '../repositories/userRepository.js';
import getRouterModels from '../db/models/routerModels.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { decrypt, isEncrypted } from '../utils/encryption.js';

const SALT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Load permissions granted by the user's position (if they are a board member with position_id).
 * @param {Object} tenantDb - Tenant DB connection
 * @param {string} userId - User _id
 * @param {string} orgId - Organization _id
 * @returns {Promise<string[]>} granted_permissions from Position, or []
 */
const getPositionPermissionsForUser = async (tenantDb, userId, orgId) => {
  try {
    const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
    const { PositionRepository } = await import('../repositories/positionRepository.js');
    const boardMemberRepo = new BoardMemberRepository(tenantDb);
    const positionRepo = new PositionRepository(tenantDb);

    const boardMember = await boardMemberRepo.findByUserId(userId, orgId);
    if (!boardMember?.position_id) return [];

    const position = await positionRepo.findById(boardMember.position_id);
    if (!position) return [];

    const result = [];

    // Include existing granted_permissions (string-based permissions)
    if (Array.isArray(position.granted_permissions) && position.granted_permissions.length) {
      result.push(...position.granted_permissions.filter(p => typeof p === 'string' && p.trim()));
    }

    // Known sidebar modules - used for defaults when module_permissions is empty
    const MODULE_IDS = [
      'dashboard', 'approval_workflow', 'charity_admin', 'policies', 'human_resources',
      'financial_mgmt', 'risk_mgmt', 'programs', 'grants_donors', 'reporting', 'systems_legal'
    ];

    // Fixed modules: dashboard (view only), approval_workflow & human_resources (view+edit)
    const FIXED_VIEW_ONLY = ['dashboard'];
    const FIXED_VIEW_EDIT = ['approval_workflow', 'human_resources'];

    const permsMap = {};
    if (Array.isArray(position.module_permissions) && position.module_permissions.length) {
      for (const mp of position.module_permissions) {
        if (!mp || !mp.module_id) continue;
        const mod = mp.module_id.toString();
        permsMap[mod] = { view: !!mp.view, edit: !!mp.edit, delete: !!mp.delete };
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
        const isFixedViewOnly = FIXED_VIEW_ONLY.includes(mod);
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
          permissions: ['*:*']
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

      // Update last login
      const userRepo = new UserRepository(tenantDb);
      await userRepo.updateLastLogin(user._id);

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

      // Normalize orgId to lowercase for consistency
      const normalizedOrgId = orgId.toLowerCase().trim();

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
        permissions: basePermissions
      });

      logInfo('User logged in', { userId: userObj._id, orgId: normalizedOrgId });

      const responseUser = {
        id: userObj._id.toString(),
        email: userObj.email || email,
        firstName: userObj.first_name || '',
        lastName: userObj.last_name || '',
        role: baseRoles[0] || 'board_member',
        permissions: basePermissions
      };

      const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
      const boardMemberRepo = new BoardMemberRepository(tenantDb);
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

      // Search each tenant DB for the invitation token
      for (const tenant of tenants) {
        try {
          const tenantDb = await getTenantConnection(tenant.orgId);
          const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
          const boardMemberRepo = new BoardMemberRepository(tenantDb);

          const boardMember = await boardMemberRepo.findByInvitationToken(token);

          if (boardMember) {
            // Check if token is expired
            if (boardMember.invitation_expires_at && new Date() > boardMember.invitation_expires_at) {
              await boardMemberRepo.updateInvitationStatus(boardMember._id, 'expired');
              throw new AppError('Invitation has expired', 410, 'INVITATION_EXPIRED');
            }

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
      const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
      const boardMemberRepo = new BoardMemberRepository(tenantDb);
      const userRepo = new UserRepository(tenantDb);

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

        const user = {
          id: existingUser._id.toString(),
          email: boardMember.email,
          firstName: boardMember.given_names,
          lastName: boardMember.family_name,
          role: 'board_member',
          permissions
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

      const user = {
        id: newUser._id.toString(),
        email: boardMember.email,
        firstName: boardMember.given_names,
        lastName: boardMember.family_name,
        role: 'board_member',
        permissions
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
}

export default new AuthService();
