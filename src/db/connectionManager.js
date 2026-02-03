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
    return tenantDb;
  } catch (error) {
    throw new Error(`Failed to get tenant connection: ${error.message}`);
  }
};

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
