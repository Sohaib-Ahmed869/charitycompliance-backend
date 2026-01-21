/**
 * Role-Based Access Control (RBAC) Middleware
 * 
 * Checks if user has required permissions to access a resource.
 * Permissions are stored in format: "module:action"
 * Examples: "module1:create", "module3:approve", "documents:export"
 */

/**
 * Check if user has required permission
 * @param {Array<string>} userPermissions - User's permissions array
 * @param {string|Array<string>} requiredPermission - Required permission(s)
 * @returns {boolean}
 */
const hasPermission = (userPermissions, requiredPermission) => {
  if (!userPermissions || !Array.isArray(userPermissions)) {
    return false;
  }

  // If requiredPermission is an array, user needs at least one
  if (Array.isArray(requiredPermission)) {
    return requiredPermission.some(perm => userPermissions.includes(perm));
  }

  // Check for exact match
  if (userPermissions.includes(requiredPermission)) {
    return true;
  }

  // Check for wildcard permissions (e.g., "module1:*" grants all module1 permissions)
  const wildcardPerm = requiredPermission.split(':')[0] + ':*';
  if (userPermissions.includes(wildcardPerm)) {
    return true;
  }

  // Check for admin permission
  if (userPermissions.includes('*:*') || userPermissions.includes('admin')) {
    return true;
  }

  return false;
};

/**
 * Check if user has required role
 * @param {Array<string>} userRoles - User's roles array
 * @param {string|Array<string>} requiredRole - Required role(s)
 * @returns {boolean}
 */
const hasRole = (userRoles, requiredRole) => {
  if (!userRoles || !Array.isArray(userRoles)) {
    return false;
  }

  if (Array.isArray(requiredRole)) {
    return requiredRole.some(role => userRoles.includes(role));
  }

  return userRoles.includes(requiredRole);
};

/**
 * RBAC Middleware Factory
 * Creates middleware that checks for specific permission(s)
 * 
 * @param {string|Array<string>} permission - Required permission(s)
 * @param {Object} options - Options
 * @param {boolean} options.requireAll - If true, requires all permissions (default: false)
 * @returns {Function} Express middleware
 */
export const requirePermission = (permission, options = {}) => {
  return (req, res, next) => {
    // Ensure user is authenticated
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const userPermissions = req.user.permissions || [];

    // Check permission
    if (options.requireAll && Array.isArray(permission)) {
      // Require all permissions
      const hasAll = permission.every(perm => hasPermission(userPermissions, perm));
      if (!hasAll) {
        return res.status(403).json({
          success: false,
          error: `Insufficient permissions. Required: ${permission.join(', ')}`
        });
      }
    } else {
      // Require at least one permission
      if (!hasPermission(userPermissions, permission)) {
        return res.status(403).json({
          success: false,
          error: `Insufficient permissions. Required: ${Array.isArray(permission) ? permission.join(' or ') : permission}`
        });
      }
    }

    next();
  };
};

/**
 * RBAC Middleware Factory for Roles
 * Creates middleware that checks for specific role(s)
 * 
 * @param {string|Array<string>} role - Required role(s)
 * @returns {Function} Express middleware
 */
export const requireRole = (role) => {
  return (req, res, next) => {
    // Ensure user is authenticated
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const userRoles = req.user.roles || [];

    // Check role
    if (!hasRole(userRoles, role)) {
      return res.status(403).json({
        success: false,
        error: `Insufficient role. Required: ${Array.isArray(role) ? role.join(' or ') : role}`
      });
    }

    next();
  };
};

/**
 * Check if user is admin
 */
export const requireAdmin = requireRole('admin');

/**
 * Check if user is board member
 */
export const requireBoardMember = requireRole(['board_member', 'responsible_person']);

/**
 * Check if user is auditor (read-only access)
 */
export const requireAuditor = requireRole('auditor');

export default {
  requirePermission,
  requireRole,
  requireAdmin,
  requireBoardMember,
  requireAuditor,
  hasPermission,
  hasRole
};
