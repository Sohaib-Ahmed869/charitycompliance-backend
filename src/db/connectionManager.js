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
 * - Context attachment: Attaches orgKey to connection for encryption plugin
 */

import mongoose from 'mongoose';
import { lookupTenant } from './router.js';

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
 * 4. Attach decrypted orgKey to connection context
 * 5. Return tenant-specific database instance
 * 6. Reset idle timer
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
    const { clusterEndpoint, dbName, orgKey } = tenantInfo;

    // 2. CONNECT: Check if we already have a connection to this Pod
    let podConnection = connectionCache.get(clusterEndpoint);

    if (!podConnection || podConnection.readyState !== 1) {
      console.log(`🔌 Opening NEW connection to Pod: ${clusterEndpoint}`);
      
      // Create new connection to Pod cluster
      podConnection = await mongoose.createConnection(clusterEndpoint, {
        maxPoolSize: MAX_POOL_SIZE,
        minPoolSize: MIN_POOL_SIZE,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      }).asPromise();

      // Store connection in cache
      connectionCache.set(clusterEndpoint, podConnection);

      // Handle connection events
      podConnection.on('error', (err) => {
        console.error(`❌ Pod connection error (${clusterEndpoint}):`, err);
      });

      podConnection.on('disconnected', () => {
        console.warn(`⚠️ Pod disconnected: ${clusterEndpoint}`);
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

    // Set new idle timer
    idleTimers.set(clusterEndpoint, setTimeout(() => {
      console.log(`💤 Closing idle Pod connection: ${clusterEndpoint}`);
      const conn = connectionCache.get(clusterEndpoint);
      if (conn) {
        conn.close().catch(err => {
          console.error(`Error closing idle connection:`, err);
        });
        connectionCache.delete(clusterEndpoint);
      }
      idleTimers.delete(clusterEndpoint);
    }, IDLE_TIMEOUT));

    // 4. CONTEXT: Get tenant-specific database and attach orgKey
    const tenantDb = podConnection.useDb(dbName, { useCache: true });
    
    // Attach organization key to connection context
    // This is used by the mongoose encryption plugin
    tenantDb.config = { orgKey };

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
