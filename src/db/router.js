/**
 * Tenant Router
 * 
 * Handles tenant lookup and routing information.
 * Queries the Router DB to find which Pod/cluster hosts an organization
 * and retrieves the encrypted organization key.
 */

import { getRouterConnection } from '../config/database.js';
import { decrypt, encrypt } from '../utils/encryption.js';
import { getMasterKey } from '../config/encryption.js';
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
 * Lookup tenant information from Router DB
 * @param {string} orgId - Organization identifier
 * @returns {Promise<TenantRecord & { orgKey: string }>} Tenant record with decrypted org key
 */
export const lookupTenant = async (orgId) => {
  if (!orgId) {
    throw new Error('Organization ID is required');
  }

  // Check cache first
  const cacheKey = `tenant:${orgId}`;
  const cached = tenantCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const routerDB = getRouterConnection();
    const tenantsCollection = routerDB.collection('tenants');

    // Query Router DB for tenant
    const tenantRecord = await tenantsCollection.findOne({ 
      orgId: orgId,
      status: 'active' // Only return active tenants
    });

    if (!tenantRecord) {
      throw new Error(`Tenant not found or inactive: ${orgId}`);
    }

    // Decrypt the organization key using master key
    const masterKey = getMasterKey();
    const orgKey = decrypt(tenantRecord.encryptedDataKey, masterKey.toString('hex'));

    // Prepare result with decrypted key
    const result = {
      orgId: tenantRecord.orgId,
      clusterEndpoint: tenantRecord.clusterEndpoint,
      dbName: tenantRecord.dbName,
      encryptedDataKey: tenantRecord.encryptedDataKey,
      status: tenantRecord.status,
      orgKey: orgKey // Decrypted key for use in connection manager
    };

    // Cache the result
    tenantCache.set(cacheKey, result);

    return result;
  } catch (error) {
    if (error.message.includes('not found')) {
      throw error;
    }
    throw new Error(`Failed to lookup tenant: ${error.message}`);
  }
};

/**
 * Clear tenant cache (useful when tenant info is updated)
 * @param {string} orgId - Organization identifier
 */
export const clearTenantCache = (orgId) => {
  if (orgId) {
    tenantCache.del(`tenant:${orgId}`);
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
    throw new Error('Missing required tenant registration fields');
  }

  try {
    const routerDB = getRouterConnection();
    const tenantsCollection = routerDB.collection('tenants');

    // Encrypt the organization key with master key
    const masterKey = getMasterKey();
    const encryptedDataKey = encrypt(orgKey, masterKey.toString('hex'));

    // Check if tenant already exists
    const existing = await tenantsCollection.findOne({ orgId });
    if (existing) {
      throw new Error(`Tenant already exists: ${orgId}`);
    }

    // Insert tenant record
    const tenantRecord = {
      orgId,
      clusterEndpoint,
      dbName,
      encryptedDataKey,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await tenantsCollection.insertOne(tenantRecord);

    return tenantRecord;
  } catch (error) {
    throw new Error(`Failed to register tenant: ${error.message}`);
  }
};

export default {
  lookupTenant,
  clearTenantCache,
  registerTenant
};
