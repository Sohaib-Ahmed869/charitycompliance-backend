/**
 * Tenant Router
 * 
 * Handles tenant lookup and routing information.
 * Queries the Router DB to find which Pod/cluster hosts an organization
 * and retrieves the encrypted organization key.
 */

import { getRouterConnection } from '../config/database.js';
import { encrypt } from '../utils/encryption.js';
import { getMasterKey } from '../config/encryption.js';
import { logError, logInfo } from '../utils/logger.js';
import NodeCache from 'node-cache';

// Cache tenant lookups to reduce Router DB queries
// TTL: 1 hour (configurable via env)
const tenantCache = new NodeCache({
  stdTTL: parseInt(process.env.TENANT_CACHE_TTL) || 3600,
  checkperiod: 600, // Check for expired keys every 10 minutes
  useClones: false
});

/**
 * Tenant record structure from Router DB
 * @typedef {Object} TenantRecord
 * @property {string} orgId - Organization identifier
 * @property {string} clusterEndpoint - MongoDB cluster connection string
 * @property {string} dbName - Database name (e.g., org_google_inc_v1)
 * @property {string} encryptedDataKey - Organization key encrypted with master key
 * @property {string} status - Tenant status (active, suspended, etc.)
 */

/**
 * Lookup tenant information from Router DB (routing only; field encryption uses master key).
 * @param {string} orgId - Organization identifier
 * @returns {Promise<{ orgId: string, clusterEndpoint: string, dbName: string, status: string }>}
 */
export const lookupTenant = async (orgId) => {
  if (!orgId) {
    throw new Error('Organization ID is required');
  }

  const normalizedOrgId = orgId.toLowerCase().trim();
  const cacheKey = `tenant:${normalizedOrgId}`;
  const cached = tenantCache.get(cacheKey);
  if (cached) return cached;

  try {
    const routerDB = getRouterConnection();
    const tenantsCollection = routerDB.collection('tenants');
    const tenantRecord = await tenantsCollection.findOne({
      orgId: normalizedOrgId,
      status: 'active'
    });

    if (!tenantRecord) {
      logError('Tenant lookup failed', null, { orgId: normalizedOrgId, reason: 'not found or inactive' });
      throw new Error(`Tenant not found or inactive: ${normalizedOrgId}`);
    }

    const result = {
      orgId: tenantRecord.orgId,
      clusterEndpoint: tenantRecord.clusterEndpoint,
      dbName: tenantRecord.dbName,
      status: tenantRecord.status
    };
    tenantCache.set(cacheKey, result);
    return result;
  } catch (error) {
    if (error.message.includes('not found')) throw error;
    logError('Tenant lookup error', error, { orgId: normalizedOrgId });
    throw new Error(`Failed to lookup tenant: ${error.message}`);
  }
};

/**
 * Clear tenant cache (useful when tenant info is updated)
 * @param {string} orgId - Organization identifier
 */
export const clearTenantCache = (orgId) => {
  if (orgId) {
    tenantCache.del(`tenant:${orgId.toLowerCase().trim()}`);
  } else {
    tenantCache.flushAll();
  }
};

/**
 * Register a new tenant in Router DB
 * @param {Object} tenantData - Tenant registration data
 * @param {string} tenantData.orgId - Organization identifier
 * @param {string} tenantData.clusterEndpoint - MongoDB cluster connection string
 * @param {string} tenantData.dbName - Database name
 * @param {string} tenantData.orgKey - Organization encryption key (will be encrypted)
 * @returns {Promise<Object>} Created tenant record
 */
export const registerTenant = async (tenantData) => {
  const { orgId, clusterEndpoint, dbName, orgKey } = tenantData;

  if (!orgId || !clusterEndpoint || !dbName || !orgKey) {
    logError('Missing tenant registration fields', null, { orgId, hasCluster: !!clusterEndpoint, hasDb: !!dbName, hasKey: !!orgKey });
    throw new Error('Missing required tenant registration fields');
  }

  // Normalize orgId to lowercase (matching schema transformation)
  const normalizedOrgId = orgId.toLowerCase().trim();

  try {
    const routerDB = getRouterConnection();
    const tenantsCollection = routerDB.collection('tenants');

    // Encrypt the organization key with master key
    const masterKey = getMasterKey();
    const encryptedDataKey = encrypt(orgKey, masterKey.toString('hex'));

    // Check if tenant already exists
    const existing = await tenantsCollection.findOne({ orgId: normalizedOrgId });
    if (existing) {
      logInfo('Tenant already exists, reactivating if needed', { orgId: normalizedOrgId, existingStatus: existing.status });
      
      // If tenant exists but is inactive, reactivate it
      if (existing.status !== 'active') {
        await tenantsCollection.updateOne(
          { orgId: normalizedOrgId },
          { $set: { status: 'active', updatedAt: new Date() } }
        );
        logInfo('Tenant reactivated', { orgId: normalizedOrgId });
        return { ...existing, status: 'active' };
      }
      
      throw new Error(`Tenant already exists: ${normalizedOrgId}`);
    }

    // Insert tenant record
    const tenantRecord = {
      orgId: normalizedOrgId,
      clusterEndpoint,
      dbName,
      encryptedDataKey,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await tenantsCollection.insertOne(tenantRecord);
    
    if (!result.acknowledged) {
      logError('Tenant insert not acknowledged', null, { orgId: normalizedOrgId });
      throw new Error('Failed to insert tenant record');
    }

    logInfo('Tenant registered successfully', { orgId: normalizedOrgId, dbName });
    
    return tenantRecord;
  } catch (error) {
    logError('Failed to register tenant', error, { orgId: normalizedOrgId });
    throw new Error(`Failed to register tenant: ${error.message}`);
  }
};

export default {
  lookupTenant,
  clearTenantCache,
  registerTenant
};
