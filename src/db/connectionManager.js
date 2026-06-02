/**
 * Connection Manager
 * 
 * Manages connections to Pod clusters (MongoDB clusters hosting tenant databases).
 * Implements LRU (Least Recently Used) caching strategy to efficiently manage
 * connections across multiple clusters.
 * 
 * Features:
 * - Lazy connection: Only connects when needed
 * - LRU cache: Closes idle connections after timeout
 * - Field encryption uses master key globally (no per-connection key)
 */

import mongoose from 'mongoose';
import { lookupTenant } from './router.js';
import { logError, logWarn, logDebug } from '../utils/logger.js';

// Configuration
const IDLE_TIMEOUT = parseInt(process.env.CONNECTION_IDLE_TIMEOUT_MS) || 10 * 60 * 1000; // 10 minutes
const MAX_POOL_SIZE = parseInt(process.env.MAX_POOL_SIZE) || 10;
const MIN_POOL_SIZE = parseInt(process.env.MIN_POOL_SIZE) || 0;

// Connection cache: Maps clusterEndpoint → mongoose.Connection
const connectionCache = new Map();

// Idle timers: Maps clusterEndpoint → setTimeout ID
const idleTimers = new Map();

/**
 * Get tenant-specific database connection
 * 
 * Flow:
 * 1. Lookup tenant in Router DB (cached)
 * 2. Check if Pod connection exists in cache
 * 3. If not, create new connection to Pod cluster
 * 4. Return tenant-specific database instance (field encryption uses master key globally)
 * 5. Reset idle timer
 * 
 * @param {string} orgId - Organization identifier
 * @returns {Promise<mongoose.Connection>} Tenant-specific database connection
 */
export const getTenantConnection = async (orgId) => {
  if (!orgId) {
    throw new Error('Organization ID is required');
  }

  try {
    // 1. LOOKUP: Get tenant routing information
    const tenantInfo = await lookupTenant(orgId);
    const { clusterEndpoint, dbName } = tenantInfo;

    // 2. CONNECT: Check if we already have a connection to this Pod
    let podConnection = connectionCache.get(clusterEndpoint);

    if (!podConnection || podConnection.readyState !== 1) {
      logDebug('Opening new Pod connection', { clusterEndpoint: clusterEndpoint.replace(/\/\/.*@/, '//***@'), orgId });
      
      podConnection = await mongoose.createConnection(clusterEndpoint, {
        maxPoolSize: MAX_POOL_SIZE,
        minPoolSize: MIN_POOL_SIZE,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      }).asPromise();

      connectionCache.set(clusterEndpoint, podConnection);

      podConnection.on('error', (err) => {
        logError('Pod connection error', err, { 
          clusterEndpoint: clusterEndpoint.replace(/\/\/.*@/, '//***@'),
          orgId 
        });
      });

      podConnection.on('disconnected', () => {
        logWarn('Pod disconnected', { 
          clusterEndpoint: clusterEndpoint.replace(/\/\/.*@/, '//***@'),
          orgId 
        });
        connectionCache.delete(clusterEndpoint);
        if (idleTimers.has(clusterEndpoint)) {
          clearTimeout(idleTimers.get(clusterEndpoint));
          idleTimers.delete(clusterEndpoint);
        }
      });
    }

    // 3. HEARTBEAT: Reset the idle timer
    if (idleTimers.has(clusterEndpoint)) {
      clearTimeout(idleTimers.get(clusterEndpoint));
    }

    idleTimers.set(clusterEndpoint, setTimeout(() => {
      logDebug('Closing idle Pod connection', { 
        clusterEndpoint: clusterEndpoint.replace(/\/\/.*@/, '//***@'),
        orgId 
      });
      const conn = connectionCache.get(clusterEndpoint);
      if (conn) {
        conn.close().catch(err => {
          logError('Error closing idle connection', err, { 
            clusterEndpoint: clusterEndpoint.replace(/\/\/.*@/, '//***@'),
            orgId 
          });
        });
        connectionCache.delete(clusterEndpoint);
      }
      idleTimers.delete(clusterEndpoint);
    }, IDLE_TIMEOUT));

    // 4. Get tenant-specific database (encryption plugin uses master key)
    const tenantDb = podConnection.useDb(dbName, { useCache: true });

    // 5. One-time self-healing — `project_refunds` historically had a
    //    plain unique index on { org_key, token }. Manual refunds (added
    //    later) have null tokens, so a second manual entry collides.
    //    Schema now uses a PARTIAL unique index (string tokens only), but
    //    Mongoose autoIndex doesn't drop the old plain one on existing
    //    collections. Detect + replace it lazily on first tenant access.
    //    Cached per tenantDb instance so this is a no-op after the first call.
    await ensureRefundTokenIndexFixed(tenantDb).catch((err) => {
      logWarn('Refund index self-heal skipped', {
        orgId,
        error: err?.message || String(err)
      });
    });

    return tenantDb;
  } catch (error) {
    throw new Error(`Failed to get tenant connection: ${error.message}`);
  }
};

// Track which tenant DBs we've already healed in this process. Cheap
// WeakSet on the connection object itself so a connection drop + reopen
// re-runs the check (necessary if a different process altered indexes).
const _refundIndexHealed = new WeakSet();

async function ensureRefundTokenIndexFixed(tenantDb) {
  if (_refundIndexHealed.has(tenantDb)) return;
  // Mark FIRST so a failure mid-way still avoids retry-storms; we'll log
  // any failure but won't keep hammering the same broken collection.
  _refundIndexHealed.add(tenantDb);

  const collection = tenantDb.collection('project_refunds');
  let indexes;
  try {
    indexes = await collection.indexes();
  } catch (err) {
    if (err?.code === 26) return; // collection doesn't exist yet
    throw err;
  }

  const PARTIAL_FIELDS = ['token', 'payment_ack_token'];
  for (const field of PARTIAL_FIELDS) {
    const bad = indexes.find((i) =>
      i.name !== '_id_'
      && i.unique === true
      && !i.partialFilterExpression
      && i.key && Object.prototype.hasOwnProperty.call(i.key, field)
    );
    if (bad) {
      logWarn(`Self-healing refund index: dropping ${bad.name}`, {});
      try {
        await collection.dropIndex(bad.name);
      } catch (err) {
        // Another process may have already dropped it — that's fine.
        if (err?.code !== 27 /* IndexNotFound */) throw err;
      }
    }
    const targetSpec = { org_key: 1, [field]: 1 };
    const targetExists = indexes.some((i) =>
      i.unique === true
      && i.partialFilterExpression
      && JSON.stringify(i.key) === JSON.stringify(targetSpec)
    );
    if (!targetExists) {
      try {
        await collection.createIndex(targetSpec, {
          unique: true,
          partialFilterExpression: { [field]: { $type: 'string' } }
        });
      } catch (err) {
        // 85 IndexOptionsConflict / 86 IndexKeySpecsConflict — leftover
        // index with same spec but wrong options. Drop by spec-derived
        // name and retry once.
        if (err?.code === 85 || err?.code === 86) {
          const derivedName = `org_key_1_${field}_1`;
          try { await collection.dropIndex(derivedName); } catch (_) {}
          await collection.createIndex(targetSpec, {
            unique: true,
            partialFilterExpression: { [field]: { $type: 'string' } }
          });
        } else {
          throw err;
        }
      }
    }
  }
}

/**
 * Close a specific Pod connection
 * @param {string} clusterEndpoint - Cluster connection string
 */
export const closePodConnection = async (clusterEndpoint) => {
  const conn = connectionCache.get(clusterEndpoint);
  if (conn) {
    await conn.close();
    connectionCache.delete(clusterEndpoint);
    if (idleTimers.has(clusterEndpoint)) {
      clearTimeout(idleTimers.get(clusterEndpoint));
      idleTimers.delete(clusterEndpoint);
    }
  }
};

/**
 * Close all Pod connections
 */
export const closeAllConnections = async () => {
  const closePromises = Array.from(connectionCache.keys()).map(endpoint => 
    closePodConnection(endpoint)
  );
  await Promise.all(closePromises);
};

/**
 * Get connection statistics
 * @returns {Object} Connection stats
 */
export const getConnectionStats = () => {
  return {
    activeConnections: connectionCache.size,
    connections: Array.from(connectionCache.keys()),
    idleTimers: idleTimers.size
  };
};

export default {
  getTenantConnection,
  closePodConnection,
  closeAllConnections,
  getConnectionStats
};
