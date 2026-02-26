/**
 * Backfill Expense Name Script
 * 
 * Populates expense_name field for old expenses that don't have it
 * Usage: node scripts/backfillExpenseName.js
 */

import mongoose from 'mongoose';
import { getTenantConnection } from '../src/db/connectionManager.js';
import { connectToMasterDb } from '../src/db/connectionManager.js';
import { logInfo, logError } from '../src/utils/logger.js';
import expenseSchema from '../src/db/schemas/platform/expenseSchema.js';

async function backfillExpenseName() {
  try {
    logInfo('Starting backfill of expense_name field');

    // Get master DB to fetch all organizations
    const masterDb = await connectToMasterDb();
    const Organization = masterDb.model('Organization', new mongoose.Schema(
      { _id: String, org_name: String },
      { collection: 'organizations' }
    ));

    const organizations = await Organization.find();
    logInfo(`Found ${organizations.length} organizations`);

    let totalUpdated = 0;

    for (const org of organizations) {
      try {
        logInfo(`Processing organization: ${org._id}`);
        const tenantDb = await getTenantConnection(org._id);
        const Expense = tenantDb.model('Expense', expenseSchema);

        // Find expenses without expense_name or with empty expense_name
        const expensesToUpdate = await Expense.find({
          $or: [
            { expense_name: { $exists: false } },
            { expense_name: '' },
            { expense_name: null }
          ]
        });

        logInfo(`Found ${expensesToUpdate.length} expenses to update in org ${org._id}`);

        for (const expense of expensesToUpdate) {
          // Use description as expense_name if not set
          const newExpenseName = expense.description || `Expense-${expense._id}`;
          
          await Expense.updateOne(
            { _id: expense._id },
            { $set: { expense_name: newExpenseName } }
          );

          totalUpdated++;
        }

        logInfo(`Updated ${expensesToUpdate.length} expenses in org ${org._id}`);
      } catch (error) {
        logError(`Error processing org ${org._id}:`, error);
      }
    }

    logInfo(`Backfill complete. Total updated: ${totalUpdated}`);
    process.exit(0);
  } catch (error) {
    logError('Backfill failed:', error);
    process.exit(1);
  }
}

backfillExpenseName();
