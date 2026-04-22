/**
 * Volunteer policy notification helper.
 *
 * Volunteers have no login, so they acknowledge policies via a public token link.
 * This helper centralises the "email every active volunteer about one policy" logic
 * and the reverse ("email one volunteer about every active policy"), so every code
 * path that activates a policy or adds a volunteer fans out emails the same way.
 */

import emailService from './emailService.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { PolicyRepository } from '../repositories/policyRepository.js';
import { createVolunteerActionToken } from './volunteerActionTokenService.js';
import { decryptBoardMemberList } from '../utils/decryptBoardMember.js';
import { getMasterKeyHex } from '../config/encryption.js';
import { logError, logInfo } from '../utils/logger.js';

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'http://localhost:5173';

function fullName(bm) {
  return `${bm?.given_names || ''} ${bm?.family_name || ''}`.trim() || 'Volunteer';
}

async function emailVolunteerAboutPolicy(orgId, volunteer, policy) {
  const tokenDoc = await createVolunteerActionToken({
    orgId,
    boardMemberId: volunteer._id,
    actionType: 'policy_ack',
    email: volunteer.email,
    metadata: { policy_id: String(policy._id) }
  });
  const acknowledgeUrl = `${FRONTEND_URL()}/public/volunteer/policy_ack/${tokenDoc.token}`;
  return emailService.sendVolunteerPolicyNotification({
    to: volunteer.email,
    recipientName: fullName(volunteer),
    policyTitle: policy.title || 'Policy',
    policyId: String(policy._id),
    acknowledgeUrl
  });
}

/**
 * Fan out policy-ack emails to every eligible volunteer for ONE policy.
 * Fires only when the policy is active. Non-blocking: errors are logged, never thrown.
 */
export async function notifyVolunteersForPolicy(orgId, tenantDb, policyLike) {
  try {
    if (!policyLike || policyLike.status !== 'active') return;
    const boardMemberRepo = new BoardMemberRepository(tenantDb);
    const members = await boardMemberRepo.findByOrgId(policyLike.org_id, false);
    // Decrypt email / name fields before use — repository returns raw encrypted docs.
    const plain = (members || []).map((m) => (m?.toObject ? m.toObject() : { ...m }));
    decryptBoardMemberList(plain, getMasterKeyHex());
    const recipients = plain.filter(
      (bm) => bm?.is_volunteer === true && bm?.email && (bm?.status || 'active') === 'active'
    );
    if (recipients.length === 0) {
      logInfo('No volunteer recipients for policy', { policyId: String(policyLike._id) });
      return;
    }

    const results = await Promise.allSettled(
      recipients.map((bm) => emailVolunteerAboutPolicy(orgId, bm, policyLike))
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      failed.forEach((f) =>
        logError('Volunteer policy-ack email failed', f.reason, { policyId: String(policyLike._id) })
      );
    }
    logInfo('Volunteer policy-ack emails dispatched', {
      policyId: String(policyLike._id),
      total: recipients.length,
      failed: failed.length
    });
  } catch (err) {
    logError('notifyVolunteersForPolicy failed', err, { policyId: String(policyLike?._id) });
  }
}

/**
 * When a brand-new volunteer joins, send them a policy-ack email for EVERY active
 * policy so their acknowledgement record catches up.
 */
export async function notifyVolunteerOfActivePolicies(orgId, tenantDb, volunteer) {
  try {
    if (!volunteer || volunteer.is_volunteer !== true || !volunteer.email) return;
    if ((volunteer.status || 'active') !== 'active') return;

    const policyRepo = new PolicyRepository(tenantDb);
    const activePolicies = await policyRepo.findByOrgId(volunteer.org_id, { status: 'active' });
    if (!activePolicies || activePolicies.length === 0) return;

    const results = await Promise.allSettled(
      activePolicies.map((p) => emailVolunteerAboutPolicy(orgId, volunteer, p))
    );
    logInfo('Backfill policy-ack emails sent to new volunteer', {
      volunteerId: String(volunteer._id),
      total: activePolicies.length,
      failed: results.filter((r) => r.status === 'rejected').length
    });
  } catch (err) {
    logError('notifyVolunteerOfActivePolicies failed', err, {
      volunteerId: String(volunteer?._id)
    });
  }
}
