/**
 * Authentication Middleware
 * 
 * Verifies JWT tokens and attaches user information to request object.
 * Supports both header-based and cookie-based token extraction.
 */

import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { buildAuditorPermissions } from '../utils/auditorAccess.js';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const _transferCache = new Map();
const TRANSFER_CACHE_TTL = 30_000; // 30s

/**
 * Compute effective module permissions for a non-admin user based on their positions.
 * Mirrors the logic used during login so runtime updates to position permissions
 * are reflected immediately without requiring a new login.
 *
 * @param {string} userId
 * @param {string} orgId - tenant orgId string (not ObjectId)
 * @returns {Promise<string[]>}
 */
async function computeRuntimePermissionsForUser(userId, orgId) {
  try {
    const { getTenantConnection } = await import('../db/connectionManager.js');
    const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
    const { PositionRepository } = await import('../repositories/positionRepository.js');
    const { OrganizationRepository } = await import('../repositories/organizationRepository.js');

    const tenantDb = await getTenantConnection(orgId);
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) return [];

    const boardMemberRepo = new BoardMemberRepository(tenantDb);
    const positionRepo = new PositionRepository(tenantDb);

    // Get ALL active board_members (user may hold multiple positions after transfer)
    const allBoardMembers = await boardMemberRepo.findAllActiveByUserId(userId, org._id);
    if (!allBoardMembers || allBoardMembers.length === 0) return [];

    const positionIds = allBoardMembers
      .map(bm => bm.position_id)
      .filter(Boolean);
    if (positionIds.length === 0) return [];

    const positions = await Promise.all(positionIds.map(pid => positionRepo.findById(pid)));

    const result = [];

    for (const position of positions) {
      if (!position) continue;

      if (Array.isArray(position.granted_permissions) && position.granted_permissions.length) {
        result.push(...position.granted_permissions.filter(p => typeof p === 'string' && p.trim()));
      }
    }

    // Known sidebar modules - used for defaults when module_permissions is empty
    const MODULE_IDS = [
      'dashboard', 'approval_workflow', 'audit_trail', 'complaints', 'charity_admin', 'policies', 'human_resources',
      'financial_mgmt', 'risk_mgmt', 'programs', 'grants_donors', 'reporting', 'systems_legal', 'donation_boxes'
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
        const isFixedViewOnly = FIXED_VIEW_ONLY.includes(mod);
        if (isFixedViewOnly || isFixedViewEdit) {
          result.push(`module:${mod}:view`);
          if (isFixedViewEdit) result.push(`module:${mod}:edit`);
        } else {
          // For non-fixed modules, default to view only to avoid over-granting edit/delete
          result.push(`module:${mod}:view`);
        }
      }
    }

    return Array.from(new Set(result));
  } catch (err) {
    // On any failure, fall back to token permissions
    return [];
  }
}

/**
 * Clear the transfer-block cache for a specific user so the middleware
 * picks up the status change on their very next API call (immediate logout).
 */
export function clearTransferCacheForUser(userId, orgId) {
  const cacheKey = `${userId}:${orgId}`;
  _transferCache.delete(cacheKey);
}

async function checkTransferredUser(userId, orgId) {
  const cacheKey = `${userId}:${orgId}`;
  const cached = _transferCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TRANSFER_CACHE_TTL) return cached.blocked;

  const { getTenantConnection } = await import('../db/connectionManager.js');
  const { BoardMemberRepository } = await import('../repositories/boardMemberRepository.js');
  const { OrganizationRepository } = await import('../repositories/organizationRepository.js');

  const tenantDb = await getTenantConnection(orgId);
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) { _transferCache.set(cacheKey, { blocked: false, ts: Date.now() }); return false; }

  const bmRepo = new BoardMemberRepository(tenantDb);
  const records = await bmRepo.BoardMember.find({ user_id: userId, org_id: org._id }).lean();
  const hasActive = records.some(r => r.is_active && r.status !== 'transferred');
  const hasTransferred = records.some(r => r.status === 'transferred');
  const blocked = records.length > 0 && !hasActive && hasTransferred;

  _transferCache.set(cacheKey, { blocked, ts: Date.now() });
  return blocked;
}

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

/**
 * Generate JWT token
 * @param {Object} payload - Token payload
 * @param {string} payload.userId - User ID
 * @param {string} payload.orgId - Organization ID
 * @param {Array<string>} payload.roles - User roles
 * @param {Object} payload.permissions - User permissions
 * @returns {string} JWT token
 */
export const generateToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
    issuer: 'charity-compliance-api',
    audience: 'charity-compliance-client'
  });
};

/**
 * Verify JWT token
 * @param {string} token - JWT token
 * @returns {Object} Decoded token payload
 */
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: 'charity-compliance-api',
      audience: 'charity-compliance-client'
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('Token has expired');
    } else if (error.name === 'JsonWebTokenError') {
      throw new Error('Invalid token');
    }
    throw error;
  }
};

/**
 * Extract token from request
 * @param {Object} req - Express request object
 * @returns {string|null} Token or null
 */
const extractToken = (req) => {
  // Check Authorization header: "Bearer <token>"
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check x-auth-token header
  if (req.headers['x-auth-token']) {
    return req.headers['x-auth-token'];
  }

  // Check cookies
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }

  return null;
};

/**
 * Authentication middleware
 * Verifies JWT and attaches user info to req.user
 */
export const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. No token provided.'
      });
    }

    // Verify token
    const decoded = verifyToken(token);

    const decodedRoles = decoded.roles || [];
    let effectivePermissions = decoded.permissions || [];
    const isAuditor = decoded.isAuditor === true;

    // Auditors: fixed view-only permissions; never merge position-based runtime perms
    if (isAuditor) {
      effectivePermissions = buildAuditorPermissions();
    } else if (!decodedRoles.includes('admin') && decoded.orgId && decoded.userId) {
      // For non-admin users, recompute permissions from DB on each request so that
      // changes to position/module permissions take effect without requiring re-login.
      const runtimePerms = await computeRuntimePermissionsForUser(decoded.userId, decoded.orgId);
      if (runtimePerms.length > 0) {
        // Include basic self permissions plus module permissions
        effectivePermissions = ['read:own', 'write:own', ...runtimePerms];
      }
    }

    // Attach user info to request
    req.user = {
      userId: decoded.userId,
      orgId: decoded.orgId,
      email: decoded.email,
      roles: decodedRoles,
      permissions: effectivePermissions,
      isAuditor
    };

    // Attach token for potential refresh
    req.token = token;

    // Check if user's position has been fully transferred (non-admin only; auditors skip)
    if (!isAuditor && !decoded.roles?.includes('admin') && decoded.orgId) {
      try {
        const isBlocked = await checkTransferredUser(decoded.userId, decoded.orgId);
        if (isBlocked) {
          return res.status(403).json({
            success: false,
            error: {
              message: 'Your position has been transferred to another person as part of a Business Continuity transfer. Please contact your administrator.',
              code: 'POSITION_TRANSFERRED'
            }
          });
        }
      } catch (_) {
        // Don't block auth if the check fails
      }

      // Also check if user account is suspended (set during BCP transfer activation)
      try {
        const { getTenantConnection } = await import('../db/connectionManager.js');
        const { UserRepository } = await import('../repositories/userRepository.js');
        const tenantDb = await getTenantConnection(decoded.orgId);
        const userRepo = new UserRepository(tenantDb);
        const usr = await userRepo.findById(decoded.userId);
        if (usr && usr.status === 'suspended') {
          return res.status(403).json({
            success: false,
            error: {
              message: 'Your account has been suspended as part of a Business Continuity transfer. Please contact your administrator.',
              code: 'POSITION_TRANSFERRED'
            }
          });
        }
      } catch (_) {
        // Don't block auth if the check fails
      }
    }

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: error.message || 'Authentication failed'
    });
  }
};

/**
 * Optional authentication middleware
 * Attaches user if token is present, but doesn't fail if missing
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (token) {
      const decoded = verifyToken(token);
      req.user = {
        userId: decoded.userId,
        orgId: decoded.orgId,
        email: decoded.email,
        roles: decoded.roles || [],
        permissions: decoded.permissions || [],
        isAuditor: decoded.isAuditor === true
      };
      req.token = token;
    }
    next();
  } catch (error) {
    // Ignore errors and continue without auth
    next();
  }
};

export default {
  authenticate,
  optionalAuth,
  generateToken,
  verifyToken
};
