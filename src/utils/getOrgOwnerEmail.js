/**
 * Resolve an org's owner email — opens the tenant DB connection and reads
 * the User collection. Used by webhook handlers and SuperAdmin endpoints
 * to address billing-related notifications. Returns null on any error.
 */

import { getTenantConnection } from '../db/connectionManager.js';

export async function getOrgOwnerEmail(orgId) {
  if (!orgId) return null;
  try {
    const tenantDb = await getTenantConnection(String(orgId).toLowerCase());
    if (!tenantDb?.collection) return null;
    const owner = await tenantDb.collection('users').findOne(
      { is_org_owner: true },
      { projection: { email: 1 } }
    );
    return owner?.email || null;
  } catch (err) {
    console.warn('[getOrgOwnerEmail] could not resolve for', orgId, err?.message || err);
    return null;
  }
}

export default getOrgOwnerEmail;
