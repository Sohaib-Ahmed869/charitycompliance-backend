/**
 * Tenant Resolver Middleware
 * 
 * Extracts organization ID from request and resolves tenant database connection.
 * Attaches tenant DB connection to request object for use in controllers.
 * 
 * Flow:
 * 1. Extract orgId from header, JWT, or params
 * 2. Lookup tenant in Router DB
 * 3. Get tenant database connection
 * 4. Attach to req.tenantDb
 */

import { getTenantConnection } from '../db/connectionManager.js';

/**
 * Resolve tenant database connection
 * 
 * Looks for orgId in:
 * 1. x-org-id header (highest priority)
 * 2. req.user.orgId (from auth middleware)
 * 3. req.params.orgId (URL parameter)
 * 4. req.body.orgId (request body - less secure)
 */
export const resolveTenant = async (req, res, next) => {
  try {
    // Extract orgId from various sources
    let orgId = req.headers['x-org-id'] ||
                req.user?.orgId ||
                req.params.orgId ||
                req.body.orgId;

    // In development, allow skipping tenant validation
    if (!orgId && process.env.SKIP_TENANT_VALIDATION === 'true' && process.env.NODE_ENV === 'development') {
      console.warn('⚠️ WARNING: Skipping tenant validation (development only)');
      return next();
    }

    if (!orgId) {
      return res.status(400).json({
        success: false,
        error: 'Organization ID is required. Provide x-org-id header or ensure user is authenticated.'
      });
    }

    // Normalize to string and lowercase so tenant lookup and decryption always use same key
    const normalizedOrgId = String(orgId).toLowerCase().trim();

    // Get tenant database connection
    const tenantDb = await getTenantConnection(normalizedOrgId);

    // Attach to request object (always use normalized id for consistency)
    req.tenantDb = tenantDb;
    req.orgId = normalizedOrgId;

    next();
  } catch (error) {
    return res.status(404).json({
      success: false,
      error: error.message || 'Failed to resolve tenant database'
    });
  }
};

/**
 * Combined middleware: Authenticate + Resolve Tenant
 * Use this when you need both authentication and tenant resolution
 */
export const authAndResolveTenant = [
  // Import authenticate dynamically to avoid circular dependencies
  async (req, res, next) => {
    const { authenticate } = await import('./auth.js');
    return authenticate(req, res, next);
  },
  resolveTenant
];

export default {
  resolveTenant,
  authAndResolveTenant
};
