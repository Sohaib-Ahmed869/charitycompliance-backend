/**
 * Bulk volunteer import service
 *
 * Mirrors the volunteer-creation side-effects already implemented in
 * `boardMemberController.createBoardMember` so a row coming from an
 * Excel/CSV upload ends up identical to one entered through the
 * single-volunteer panel:
 *
 *   1. Create the board_member row with `is_volunteer: true` and a
 *      7-day invitation token (`has_system_access: false` — volunteers
 *      don't get a login, they get action links).
 *   2. Generate three signed public action tokens (complaint, risk, COI)
 *      and embed them in the invitation email.
 *   3. Send the branded invitation email via `emailService`.
 *   4. Update the board_member's invitation_status to 'sent'.
 *   5. Fire-and-forget a policy-backfill so every active policy
 *      generates an acknowledgement task on day one.
 *
 * No DB transaction wraps the whole batch — each row is independent so
 * a single bad row does not roll back its sibling rows. Per-row
 * errors are collected and returned to the caller.
 */

import crypto from 'crypto';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { OnboardingProgressRepository } from '../repositories/onboardingProgressRepository.js';
import emailService from '../services/emailService.js';
import { createVolunteerActionToken } from '../services/volunteerActionTokenService.js';
import { notifyVolunteerOfActivePolicies } from '../services/volunteerPolicyNotifier.js';
import { logInfo, logError } from '../utils/logger.js';
import { maskEmail } from '../utils/maskPii.js';
import { getFrontendBaseUrl } from '../utils/frontendUrl.js';

/* ------------------------------------------------------------------ */
/* Row-level validation                                                */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Coerce a raw spreadsheet cell into an ISO date string. Returns null
 * if the value is empty or unparsable. Date-typed cells from xlsx come
 * through as JS Dates already; string cells like "12/06/2026" are
 * parsed leniently.
 */
const toIsoDate = (v) => {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/**
 * Validate a single volunteer row. Returns `{ ok, data, errors }`.
 * `data` is only safe to use when `ok` is true.
 */
export const validateVolunteerRow = (raw) => {
  const errors = [];
  const given_names = String(raw?.given_names || '').trim();
  const family_name = String(raw?.family_name || '').trim();
  const email       = String(raw?.email || '').trim().toLowerCase();
  const phone       = String(raw?.phone || '').trim();
  const position    = String(raw?.position || '').trim();

  if (!given_names) errors.push({ field: 'given_names', message: 'First name is required' });
  if (!family_name) errors.push({ field: 'family_name', message: 'Last name is required' });
  if (!email)        errors.push({ field: 'email',        message: 'Email is required' });
  else if (!EMAIL_RE.test(email)) errors.push({ field: 'email', message: 'Invalid email address' });

  const licNum = String(raw?.licence_number || '').trim();
  const pasNum = String(raw?.passport_number || '').trim();
  if (!licNum && !pasNum) {
    errors.push({
      field: 'identification',
      message: 'At least one of driver\'s licence or passport number is required'
    });
  }

  const identification = {};
  if (licNum) {
    identification.licence = {
      number:      licNum,
      issue_date:  toIsoDate(raw?.licence_issue_date) || undefined,
      expiry_date: toIsoDate(raw?.licence_expiry_date) || undefined
    };
  }
  if (pasNum) {
    identification.passport = {
      number:      pasNum,
      issue_date:  toIsoDate(raw?.passport_issue_date) || undefined,
      expiry_date: toIsoDate(raw?.passport_expiry_date) || undefined
    };
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    data: {
      given_names,
      family_name,
      email,
      phone: phone || null,
      position: position || null,
      identification,
      is_volunteer: true,
      is_board_member: false,
      is_head_of_department: false
    }
  };
};

/* ------------------------------------------------------------------ */
/* Per-row create + side-effects                                       */
/* ------------------------------------------------------------------ */

/**
 * Run the full single-volunteer creation flow for one row.
 * @param tenantDb mongoose connection bound to the tenant DB
 * @param org      organisation document (already loaded once for the batch)
 * @param inviter  shape: { firstName, lastName } — for the email footer
 * @param data     output of `validateVolunteerRow(...).data`
 * @returns        { boardMemberId, email, invited }
 */
const createOneVolunteer = async ({ tenantDb, orgId, org, inviter, data }) => {
  const boardMemberRepo = new BoardMemberRepository(tenantDb);

  // Always invite for bulk-imported volunteers. Matches the single
  // panel's `invite: true, system_access: false` shape.
  const invitationToken = crypto.randomBytes(32).toString('hex');
  const invitationExpiresAt = new Date();
  invitationExpiresAt.setDate(invitationExpiresAt.getDate() + 7);

  const boardMember = await boardMemberRepo.create({
    org_id: org._id,
    ...data,
    invitation_token: invitationToken,
    invitation_status: 'pending',
    invitation_expires_at: invitationExpiresAt,
    has_system_access: false
  });

  // Generate the three public volunteer action tokens.
  const frontendUrl = getFrontendBaseUrl();
  const [complaintDoc, riskDoc, coiDoc] = await Promise.all([
    createVolunteerActionToken({ orgId, boardMemberId: boardMember._id, actionType: 'complaint', email: data.email }),
    createVolunteerActionToken({ orgId, boardMemberId: boardMember._id, actionType: 'risk',      email: data.email }),
    createVolunteerActionToken({ orgId, boardMemberId: boardMember._id, actionType: 'coi',       email: data.email })
  ]);
  const volunteerActionLinks = {
    complaint: `${frontendUrl}/public/volunteer/complaint/${complaintDoc.token}`,
    risk:      `${frontendUrl}/public/volunteer/risk/${riskDoc.token}`,
    coi:       `${frontendUrl}/public/volunteer/coi/${coiDoc.token}`
  };

  // Send the branded invitation email. Failure here is logged but
  // doesn't roll the row back — the volunteer record still exists and
  // the action links can be re-sent from the Volunteers page.
  let invited = false;
  try {
    await emailService.sendBoardMemberInvitation({
      to: data.email,
      recipientName: `${data.given_names} ${data.family_name}`,
      organizationName: org.name || 'Your Organization',
      position: data.position || null,
      invitationToken,
      inviterName: inviter?.firstName ? `${inviter.firstName} ${inviter.lastName || ''}`.trim() : null,
      volunteerActionLinks
    });
    await boardMemberRepo.updateInvitationStatus(boardMember._id, 'sent', {
      invitation_sent_at: new Date()
    });
    invited = true;
  } catch (err) {
    logError('Bulk volunteer import: invitation email failed', err, {
      boardMemberId: boardMember._id,
      email: data.email,
      orgId
    });
  }

  // Backfill policy ack tasks. Same fire-and-forget pattern the
  // single-create controller uses.
  notifyVolunteerOfActivePolicies(orgId, tenantDb, {
    _id: boardMember._id,
    org_id: org._id,
    email: data.email,
    given_names: data.given_names,
    family_name: data.family_name,
    is_volunteer: true,
    status: 'active'
  }).catch((err) => logError('Bulk volunteer import: policy backfill failed', err, { boardMemberId: boardMember._id }));

  return { boardMemberId: String(boardMember._id), email: data.email, invited };
};

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Process an array of pre-validated volunteer rows. Each row should
 * already be the output of `validateVolunteerRow(...).data` — but to
 * be defensive we revalidate here so a malicious / outdated client
 * can't bypass the at-least-one-ID rule.
 *
 * Returns:
 *   {
 *     created:    [{ row_number, board_member_id, email, invited }],
 *     failed:     [{ row_number, email, errors: [{ field, message }] }],
 *     duplicates: [{ row_number, email, reason, existing_id }],
 *     summary:    { total, created, failed, duplicates }
 *   }
 */
export const runBulkVolunteerImport = async ({ tenantDb, orgId, inviter, rows }) => {
  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    const err = new Error('Organization not found');
    err.code = 'ORG_NOT_FOUND';
    throw err;
  }

  const created = [];
  const failed  = [];
  const duplicates = [];

  // Track emails seen earlier in THIS file so two identical rows in the
  // same upload don't both create a record.
  const boardMemberRepo = new BoardMemberRepository(tenantDb);
  const seenEmails = new Set();

  // Process sequentially rather than in parallel — the email service
  // and Mongoose connection don't love simultaneous bursts on a small
  // tenant DB, and we'd rather report errors row-by-row anyway.
  for (let i = 0; i < rows.length; i += 1) {
    const rowNumber = i + 2; // header row = 1; first data row = 2
    const raw = rows[i] || {};

    const { ok, data, errors } = validateVolunteerRow(raw);
    if (!ok) {
      failed.push({ row_number: rowNumber, email: raw.email || null, errors });
      continue;
    }

    // Deduplicate on email — against earlier rows in this file and against
    // any active person already in the org. A duplicate is skipped (not
    // failed) so re-running an import is safe and idempotent-ish.
    if (seenEmails.has(data.email)) {
      duplicates.push({ row_number: rowNumber, email: data.email, reason: 'Duplicate of an earlier row in this file', existing_id: null });
      continue;
    }
    let existingPerson = null;
    try {
      existingPerson = await boardMemberRepo.findActiveByEmailInOrg(data.email, org._id);
    } catch (err) {
      logError('Bulk volunteer import: dedup lookup failed', err, { rowNumber, email: maskEmail(data.email), orgId });
    }
    if (existingPerson) {
      seenEmails.add(data.email);
      duplicates.push({ row_number: rowNumber, email: data.email, reason: 'A person with this email already exists', existing_id: String(existingPerson._id) });
      continue;
    }
    seenEmails.add(data.email);

    try {
      const result = await createOneVolunteer({ tenantDb, orgId, org, inviter, data });
      created.push({ row_number: rowNumber, ...result });
    } catch (err) {
      logError('Bulk volunteer import: row failed', err, { rowNumber, email: maskEmail(data.email), orgId });
      failed.push({
        row_number: rowNumber,
        email: data.email,
        errors: [{ field: '_row', message: err?.message || 'Failed to create volunteer' }]
      });
    }
  }

  // Onboarding step — mirror the single-create logic. If this batch
  // pushed the org from 0 to ≥1 responsible person, mark the step
  // complete.
  if (created.length > 0) {
    try {
      const count = await boardMemberRepo.countByOrgId(org._id);
      if (count === created.length) {
        const progressRepo = new OnboardingProgressRepository(tenantDb);
        await progressRepo.updateProfileStep(org._id, 'responsible_people_complete', true);
      }
    } catch (err) {
      logError('Bulk volunteer import: onboarding progress update failed', err, { orgId });
    }
  }

  logInfo('Bulk volunteer import complete', {
    orgId,
    total: rows.length,
    created: created.length,
    failed: failed.length,
    duplicates: duplicates.length
  });

  return {
    created,
    failed,
    duplicates,
    summary: {
      total: rows.length,
      created: created.length,
      failed: failed.length,
      duplicates: duplicates.length
    }
  };
};
