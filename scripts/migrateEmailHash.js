/**
 * Migration Script: Update email_hash for existing users
 * 
 * This script updates all existing users' email_hash values to use MASTER_KEY_HEX
 * instead of orgKey, enabling cross-tenant login search.
 * 
 * Run: node backend/scripts/migrateEmailHash.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import config from '../src/config/index.js';
import { getMasterKeyHex } from '../src/config/encryption.js';
import { connectRouterDB } from '../src/config/database.js';
import { getTenantConnection } from '../src/db/connectionManager.js';
import getRouterModels from '../src/db/models/routerModels.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import crypto from 'crypto';

dotenv.config();

/**
 * Create email hash using master key
 */
function createEmailHash(email) {
  const masterKey = config.encryption.masterKeyHex;
  return crypto.createHmac('sha256', Buffer.from(masterKey, 'hex'))
    .update(email.toLowerCase().trim())
    .digest('hex');
}

async function migrateEmailHash() {
  try {
    console.log('Starting email_hash migration...');

    // Connect to Router DB
    await connectRouterDB();
    console.log('Connected to Router DB');

    const routerModels = getRouterModels();
    const tenantDocs = await routerModels.Tenant.find({ status: 'active' });
    console.log(`Found ${tenantDocs.length} active tenants`);

    let totalUpdated = 0;

    for (const tenantDoc of tenantDocs) {
      try {
        const orgId = tenantDoc.orgId || tenantDoc._id.toString();
        console.log(`\nProcessing tenant: ${orgId}`);
        
        const tenantDb = await getTenantConnection(orgId);
        const userRepo = new UserRepository(tenantDb);
        
        // Get all users using repository
        const users = await userRepo.User.find({});
        console.log(`  Found ${users.length} users`);

        let updated = 0;
        const keyHex = getMasterKeyHex();
        const { decrypt, isEncrypted } = await import('../src/utils/encryption.js');

        for (const user of users) {
          try {
            let plainEmail = null;
            if (user.email) {
              if (isEncrypted(user.email)) {
                plainEmail = decrypt(user.email, keyHex);
              } else {
                plainEmail = user.email;
              }
            }

            if (!plainEmail) {
              console.log(`  User ${user._id}: No email found, skipping`);
              continue;
            }

            // Calculate new hash with master key
            const newHash = createEmailHash(plainEmail);
            
            // Update if hash is missing or different
            if (!user.email_hash || user.email_hash !== newHash) {
              await userRepo.User.updateOne(
                { _id: user._id },
                { $set: { email_hash: newHash } }
              );
              updated++;
              console.log(`  Updated user ${user._id}: ${plainEmail.substring(0, 3)}***`);
            }
          } catch (error) {
            console.error(`  Error processing user ${user._id}:`, error.message);
          }
        }

        totalUpdated += updated;
        console.log(`  Updated ${updated} users in ${orgId}`);
      } catch (error) {
        const errorOrgId = tenantDoc?.orgId || tenantDoc?._id?.toString() || 'unknown';
        console.error(`Error processing tenant ${errorOrgId}:`, error.message);
      }
    }

    console.log(`\nMigration complete! Total users updated: ${totalUpdated}`);
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

migrateEmailHash();
