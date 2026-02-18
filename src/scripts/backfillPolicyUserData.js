/**
 * Backfill Policy Data Script
 * Fills missing user_name, user_title, updated_by_name, updated_by_title in existing documents
 * Run: node backfillPolicyUserData.js <orgSlug>
 */

import mongoose from 'mongoose';
import { getTenantConnection } from '../db/connectionManager.js';
import { connectRouterDB } from '../config/database.js';
import { PolicyRepository } from '../repositories/policyRepository.js';
import { PolicyAcknowledgementRepository } from '../repositories/policyAcknowledgementRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import config from '../config/index.js';

async function backfillPolicyData(orgSlug) {
  try {
    console.log(`Starting backfill for organization: ${orgSlug}`);
    
    // Connect to router database first
    console.log('Connecting to router database...');
    await connectRouterDB();
    console.log('✓ Router database connected');
    
    const tenantDb = await getTenantConnection(orgSlug);
    const policyRepo = new PolicyRepository(tenantDb);
    const acknowledgementRepo = new PolicyAcknowledgementRepository(tenantDb);
    const userRepo = new UserRepository(tenantDb);
    const boardMemberRepo = new BoardMemberRepository(tenantDb);
    const orgRepo = new OrganizationRepository(tenantDb);

    const org = await orgRepo.findOne();
    if (!org) {
      console.error('Organization not found');
      return;
    }

    console.log(`Organization found: ${org.name}`);

    // Backfill Policy Acknowledgements
    console.log('\n--- Backfilling Policy Acknowledgements ---');
    const acknowledgements = await acknowledgementRepo.PolicyAcknowledgement.find({
      $or: [
        { user_name: { $exists: false } },
        { user_name: null },
        { user_name: '' }
      ]
    });

    console.log(`Found ${acknowledgements.length} acknowledgements missing user_name`);

    for (const ack of acknowledgements) {
      try {
        const user = await userRepo.findById(ack.user_id);
        if (user) {
          const userName = user.first_name && user.last_name 
            ? `${user.first_name} ${user.last_name}` 
            : user.email;

          let userTitle = undefined;
          const boardMember = await boardMemberRepo.findByUserId(ack.user_id, org._id);
          if (boardMember) {
            userTitle = boardMember.position || boardMember.custom_position_title;
          }

          await acknowledgementRepo.PolicyAcknowledgement.findByIdAndUpdate(
            ack._id,
            {
              $set: {
                user_name: userName,
                user_title: userTitle
              }
            }
          );
          console.log(`✓ Updated acknowledgement ${ack._id}: ${userName}`);
        }
      } catch (err) {
        console.error(`✗ Error updating acknowledgement ${ack._id}:`, err.message);
      }
    }

    // Backfill Policy Document Logs
    console.log('\n--- Backfilling Policy Document Logs ---');
    const logs = await policyRepo.PolicyDocumentLog.find({
      $or: [
        { updated_by_name: { $exists: false } },
        { updated_by_name: null },
        { updated_by_name: '' }
      ],
      updated_by: { $exists: true, $ne: null }
    });

    console.log(`Found ${logs.length} document logs missing updated_by_name`);

    for (const log of logs) {
      try {
        const user = await userRepo.findById(log.updated_by);
        if (user) {
          const updatedByName = user.first_name && user.last_name 
            ? `${user.first_name} ${user.last_name}` 
            : user.email;

          let updatedByTitle = undefined;
          const boardMember = await boardMemberRepo.findByUserId(log.updated_by, org._id);
          if (boardMember) {
            updatedByTitle = boardMember.position || boardMember.custom_position_title;
          }

          await policyRepo.PolicyDocumentLog.findByIdAndUpdate(
            log._id,
            {
              $set: {
                updated_by_name: updatedByName,
                updated_by_title: updatedByTitle
              }
            }
          );
          console.log(`✓ Updated log ${log._id}: ${updatedByName}`);
        }
      } catch (err) {
        console.error(`✗ Error updating log ${log._id}:`, err.message);
      }
    }

    // Backfill Policy review_history
    console.log('\n--- Backfilling Policy review_history ---');
    const policies = await policyRepo.Policy.find({
      review_history: { $exists: true, $ne: [] },
      $or: [
        { 'review_history.reviewed_by_name': { $exists: false } },
        { 'review_history.reviewed_by_name': null }
      ]
    });

    console.log(`Found ${policies.length} policies with empty review_history names`);

    for (const policy of policies) {
      try {
        const updatedReviewHistory = await Promise.all(
          policy.review_history.map(async (review) => {
            if (!review.reviewed_by_name || review.reviewed_by_name === '') {
              const user = await userRepo.findById(review.reviewed_by);
              if (user) {
                const reviewedByName = user.first_name && user.last_name 
                  ? `${user.first_name} ${user.last_name}` 
                  : user.email;

                let reviewedByTitle = undefined;
                const boardMember = await boardMemberRepo.findByUserId(review.reviewed_by, org._id);
                if (boardMember) {
                  reviewedByTitle = boardMember.position || boardMember.custom_position_title;
                }

                return {
                  ...review,
                  reviewed_by_name: reviewedByName,
                  reviewed_by_title: reviewedByTitle
                };
              }
            }
            return review;
          })
        );

        await policyRepo.Policy.findByIdAndUpdate(
          policy._id,
          { $set: { review_history: updatedReviewHistory } }
        );
        console.log(`✓ Updated policy ${policy._id} review_history`);
      } catch (err) {
        console.error(`✗ Error updating policy ${policy._id}:`, err.message);
      }
    }

    console.log('\n✅ Backfill complete!');
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Get org slug from command line args
const orgSlug = process.argv[2];
if (!orgSlug) {
  console.error('Usage: node backfillPolicyUserData.js <orgSlug>');
  process.exit(1);
}

backfillPolicyData(orgSlug);
