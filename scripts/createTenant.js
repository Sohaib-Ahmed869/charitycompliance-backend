/**
 * Utility script to manually create a missing tenant
 * 
 * Usage: node scripts/createTenant.js <orgId>
 * Example: node scripts/createTenant.js compliance_212312
 */

import dotenv from 'dotenv';
import { registerTenant } from '../src/db/router.js';
import { generateOrgKey } from '../src/config/encryption.js';
import { connectRouterDB, closeRouterDB } from '../src/config/database.js';

dotenv.config();

const orgId = process.argv[2];

if (!orgId) {
  console.error('❌ Error: orgId is required');
  console.log('Usage: node scripts/createTenant.js <orgId>');
  console.log('Example: node scripts/createTenant.js compliance_212312');
  process.exit(1);
}

async function createTenant() {
  try {
    console.log(`🔧 Creating tenant: ${orgId}`);
    
    // Connect to Router DB first
    console.log('📡 Connecting to Router Database...');
    await connectRouterDB();
    console.log('✅ Connected to Router Database');
    
    // Generate organization encryption key
    const orgKey = generateOrgKey();
    
    // Get cluster endpoint from env
    const clusterEndpoint = process.env.POD_CLUSTER_ENDPOINT || 
                           process.env.ROUTER_DB_URI?.replace('/router_db', '') ||
                           process.env.MONGODB_URI?.replace('/router_db', '');
    
    if (!clusterEndpoint) {
      throw new Error('Missing cluster endpoint. Set POD_CLUSTER_ENDPOINT or ROUTER_DB_URI in .env');
    }
    
    const dbName = `org_${orgId}_v1`;
    
    console.log(`📦 Database name: ${dbName}`);
    console.log(`🔗 Cluster endpoint: ${clusterEndpoint.replace(/\/\/.*@/, '//***@')}`);
    
    // Register tenant
    await registerTenant({
      orgId,
      clusterEndpoint,
      dbName,
      orgKey
    });
    
    console.log('✅ Tenant created successfully!');
    console.log(`\nYou can now use orgId: ${orgId}`);
    
    // Close connection
    await closeRouterDB();
    process.exit(0);
  } catch (error) {
    if (error.message.includes('already exists')) {
      console.log('⚠️  Tenant already exists. If it\'s inactive, you need to update it manually in MongoDB.');
      console.log('\nTo activate it, run in MongoDB:');
      console.log(`db.tenants.updateOne({ orgId: "${orgId}" }, { $set: { status: "active" } })`);
    } else {
      console.error('❌ Error creating tenant:', error.message);
    }
    
    // Close connection on error
    try {
      await closeRouterDB();
    } catch (e) {
      // Ignore close errors
    }
    process.exit(1);
  }
}

createTenant();
