import getRouterModels from '../db/models/routerModels.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { UserRepository } from '../repositories/userRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError } from './logger.js';

/**
 * Enforce global email uniqueness across tenants.
 * If the email exists in any OTHER tenant, throw EMAIL_EXISTS_GLOBAL.
 *
 * Note: current org may legitimately contain this email already (e.g. editing a record),
 * so this only blocks cross-tenant collisions.
 */
export async function ensureEmailNotInOtherTenants(email, currentOrgId) {
  const normalizedEmail = String(email || '').toLowerCase().trim();
  if (!normalizedEmail) return;

  const current = String(currentOrgId || '').toLowerCase().trim();
  const routerModels = getRouterModels();
  const tenants = await routerModels.Tenant.find({ status: 'active' })
    .select({ orgId: 1 })
    .lean();

  for (const tenant of tenants || []) {
    const orgId = String(tenant?.orgId || '').toLowerCase().trim();
    if (!orgId || orgId === current) continue;
    try {
      const tenantDb = await getTenantConnection(orgId);
      const userRepo = new UserRepository(tenantDb);
      const existing = await userRepo.findByEmail(normalizedEmail);
      if (existing) {
        throw new AppError(
          'This email is already registered in another organisation. Use a different email.',
          409,
          'EMAIL_EXISTS_GLOBAL'
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Non-blocking if a tenant is temporarily unreachable; log for investigation.
      logError('Cross-tenant email check failed', { orgId, error: err?.message });
    }
  }
}

