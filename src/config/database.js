/**
 * Router Database Connection
 * 
 * This is the central shared database that stores:
 * - Tenant routing information (which Pod/cluster hosts each organization)
 * - Subscription plans and organization subscriptions
 * - Payment history
 * - Website leads
 * 
 * This is the ONLY shared database. All tenant data is isolated in separate databases.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { logError, logInfo, logWarn } from '../utils/logger.js';

dotenv.config();

const ROUTER_DB_URI = process.env.ROUTER_DB_URI;

if (!ROUTER_DB_URI) {
  throw new Error('ROUTER_DB_URI environment variable is required');
}

// Create connection to Router DB
let routerConnection = null;

/**
 * Connect to Router Database
 * @returns {Promise<mongoose.Connection>}
 */
export const connectRouterDB = async () => {
  if (routerConnection && routerConnection.readyState === 1) {
    return routerConnection;
  }

  try {
    routerConnection = await mongoose.createConnection(ROUTER_DB_URI, {
      maxPoolSize: parseInt(process.env.MAX_POOL_SIZE) || 10,
      minPoolSize: parseInt(process.env.MIN_POOL_SIZE) || 0,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    }).asPromise();

    logInfo('Router Database connected', { uri: ROUTER_DB_URI.replace(/\/\/.*@/, '//***@') });
    
    routerConnection.on('error', (err) => {
      logError('Router Database connection error', err, { uri: ROUTER_DB_URI.replace(/\/\/.*@/, '//***@') });
    });

    routerConnection.on('disconnected', () => {
      logWarn('Router Database disconnected');
    });

    return routerConnection;
  } catch (error) {
    logError('Failed to connect to Router Database', error, { uri: ROUTER_DB_URI.replace(/\/\/.*@/, '//***@') });
    throw error;
  }
};

/**
 * Get Router Database Connection
 * @returns {mongoose.Connection}
 */
export const getRouterConnection = () => {
  if (!routerConnection || routerConnection.readyState !== 1) {
    throw new Error('Router Database not connected. Call connectRouterDB() first.');
  }
  return routerConnection;
};

/**
 * Close Router Database Connection
 */
export const closeRouterDB = async () => {
  if (routerConnection) {
    await routerConnection.close();
    routerConnection = null;
  }
};

export default {
  connectRouterDB,
  getRouterConnection,
  closeRouterDB
};
