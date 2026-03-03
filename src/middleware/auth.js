/**
 * Authentication Middleware
 * 
 * Verifies JWT tokens and attaches user information to request object.
 * Supports both header-based and cookie-based token extraction.
 */

import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const _transferCache = new Map();
const TRANSFER_CACHE_TTL = 30_000; // 30s

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

    // Attach user info to request
    req.user = {
      userId: decoded.userId,
      orgId: decoded.orgId,
      email: decoded.email,
      roles: decoded.roles || [],
      permissions: decoded.permissions || []
    };

    // Attach token for potential refresh
    req.token = token;

    // Check if user's position has been fully transferred (non-admin only)
    if (!decoded.roles?.includes('admin') && decoded.orgId) {
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
        permissions: decoded.permissions || []
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
