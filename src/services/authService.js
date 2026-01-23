/**
 * Authentication Service
 * 
 * Business logic for authentication operations
 */

import bcrypt from 'bcryptjs';
import { generateToken } from '../middleware/auth.js';
import { generateOrgKey } from '../config/encryption.js';
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
 * Helper to decrypt user fields manually if plugin didn't work
 */
const decryptUserFields = (userDoc, orgKey) => {
  const userObj = userDoc.toObject ? userDoc.toObject() : userDoc;
  const decrypted = { ...userObj };

  if (orgKey && userObj.email && isEncrypted(userObj.email)) {
    try {
      decrypted.email = decrypt(userObj.email, orgKey);
    } catch (error) {
      logError('Failed to decrypt email', error);
    }
  }

  if (orgKey && userObj.first_name && isEncrypted(userObj.first_name)) {
    try {
      decrypted.first_name = decrypt(userObj.first_name, orgKey);
    } catch (error) {
      logError('Failed to decrypt first_name', error);
    }
  }

  if (orgKey && userObj.last_name && isEncrypted(userObj.last_name)) {
    try {
      decrypted.last_name = decrypt(userObj.last_name, orgKey);
    } catch (error) {
      logError('Failed to decrypt last_name', error);
    }
  }

  return decrypted;
};

export class AuthService {
  async register(registerData) {
    const { email, password, organizationName, firstName, lastName } = registerData;

    try {
      const routerModels = getRouterModels();
      
      // Check if email already exists (check all tenant DBs via Router DB)
      // For now, we'll create orgId from organization name
      const orgId = this.generateOrgId(organizationName);
      
      logInfo('Starting registration', { orgId, organizationName });
      
      // Check if tenant already exists (using normalized/lowercase orgId)
      const existingTenant = await routerModels.Tenant.findOne({ orgId: orgId.toLowerCase() });
      if (existingTenant && existingTenant.status === 'active') {
        throw new AppError('Organization already exists', 409, 'ORG_EXISTS');
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
      const user = await userRepo.create({
        email,
        password_hash,
        first_name: firstName,
        last_name: lastName,
        status: 'active'
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
      
      // Use the orgKey we generated earlier (same as tenantDb.config.orgKey)
      // Manually decrypt if plugin didn't work
      const userObj = decryptUserFields(decryptedUser, orgKey);
      
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
          lastName: userObj.last_name || lastName
        },
        token,
        orgId: normalizedOrgId
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logError('Registration failed', error, { email, organizationName });
      throw new AppError('Registration failed', 500, 'REGISTRATION_ERROR');
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
      
      // Get org key from tenant DB connection
      const orgKey = tenantDb.config.orgKey;
      
      // Manually decrypt if plugin didn't work
      const userObj = decryptUserFields(decryptedUser, orgKey);

      // Normalize orgId to lowercase for consistency
      const normalizedOrgId = orgId.toLowerCase().trim();

      // Generate token
      const token = generateToken({
        userId: userObj._id.toString(),
        orgId: normalizedOrgId,
        email: userObj.email || email,
        roles: ['admin'], // TODO: Get from user_roles
        permissions: ['*:*'] // TODO: Get from roles
      });

      logInfo('User logged in', { userId: userObj._id, orgId: normalizedOrgId });

      return {
        user: {
          id: userObj._id.toString(),
          email: userObj.email || email,
          firstName: userObj.first_name || '',
          lastName: userObj.last_name || ''
        },
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
}

export default new AuthService();
