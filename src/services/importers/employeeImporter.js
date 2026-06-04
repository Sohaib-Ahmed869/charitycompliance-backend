/**
 * employeeImporter — bulk-import config for staff / employees.
 *
 * Staff are stored as board_member rows with no discriminator flags
 * (is_volunteer = false, is_board_member = false), so imported employees
 * end up identical to a staff record created through the form. Unlike
 * volunteers they get NO invitation email and NO public action links —
 * they are reference records until someone grants them access.
 *
 * Because they are non-volunteers, the board_member schema requires the
 * fuller field set (DOB, position, residential address, at least one
 * government ID), which this importer validates per row.
 *
 * Dedup: a row is skipped when its email matches an active person already
 * in the org (or an earlier row in the same upload). Employees have no
 * per-record approval workflow, so there is no `approval` block.
 */

import { BoardMemberRepository } from '../../repositories/boardMemberRepository.js';
import { OrganizationRepository } from '../../repositories/organizationRepository.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

const str = (v) => String(v ?? '').trim();
const toIsoDate = (v) => {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const validateRow = (raw) => {
  const errors = [];
  const given_names = str(raw?.given_names);
  const family_name = str(raw?.family_name);
  const email = str(raw?.email).toLowerCase();
  const position = str(raw?.position);
  const dob = toIsoDate(raw?.date_of_birth);
  const line1 = str(raw?.address_line1);
  const suburb = str(raw?.suburb);
  const state = str(raw?.state).toUpperCase();
  const postcode = str(raw?.postcode);
  const licNum = str(raw?.licence_number);
  const pasNum = str(raw?.passport_number);

  if (!given_names) errors.push({ field: 'given_names', message: 'First name is required' });
  if (!family_name) errors.push({ field: 'family_name', message: 'Last name is required' });
  if (!email) errors.push({ field: 'email', message: 'Email is required' });
  else if (!EMAIL_RE.test(email)) errors.push({ field: 'email', message: 'Invalid email address' });
  if (!position) errors.push({ field: 'position', message: 'Position is required' });
  if (!dob) errors.push({ field: 'date_of_birth', message: 'A valid date of birth is required' });
  if (!line1) errors.push({ field: 'address_line1', message: 'Address line 1 is required' });
  if (!suburb) errors.push({ field: 'suburb', message: 'Suburb is required' });
  if (!state || !STATES.includes(state)) {
    errors.push({ field: 'state', message: `State must be one of: ${STATES.join(', ')}` });
  }
  if (!postcode) errors.push({ field: 'postcode', message: 'Postcode is required' });
  if (!licNum && !pasNum) {
    errors.push({ field: 'identification', message: 'At least one of driver\'s licence or passport number is required' });
  }

  if (errors.length > 0) return { ok: false, errors };

  const identification = {};
  if (licNum) {
    identification.licence = {
      number: licNum,
      issue_date: toIsoDate(raw?.licence_issue_date) || undefined,
      expiry_date: toIsoDate(raw?.licence_expiry_date) || undefined
    };
  }
  if (pasNum) {
    identification.passport = {
      number: pasNum,
      issue_date: toIsoDate(raw?.passport_issue_date) || undefined,
      expiry_date: toIsoDate(raw?.passport_expiry_date) || undefined
    };
  }

  return {
    ok: true,
    data: {
      given_names,
      family_name,
      email,
      phone: str(raw?.phone) || undefined,
      position,
      department: str(raw?.department) || undefined,
      date_of_birth: dob,
      appointment_date: toIsoDate(raw?.appointment_date) || undefined,
      residential_address: { line1, suburb, state, postcode },
      identification,
      is_volunteer: false,
      is_board_member: false,
      is_head_of_department: false
    }
  };
};

export const employeeImporter = {
  entityName: 'employee',

  labelOf: (x) => {
    const name = [x?.given_names, x?.family_name].filter(Boolean).join(' ');
    return name || x?.email || null;
  },

  validateRow,

  dedupe: {
    keyOf: (data) => (data.email ? `email:${data.email}` : null),
    findExisting: (ctx, data) =>
      ctx.boardMemberRepo.findActiveByEmailInOrg(data.email, ctx.orgObjectId)
  },

  prepare: async ({ tenantDb }) => {
    const org = await new OrganizationRepository(tenantDb).findOne();
    if (!org) {
      const err = new Error('Organization not found');
      err.code = 'ORG_NOT_FOUND';
      throw err;
    }
    return { boardMemberRepo: new BoardMemberRepository(tenantDb), orgObjectId: org._id };
  },

  createOne: (ctx, data) =>
    ctx.boardMemberRepo.create({
      org_id: ctx.orgObjectId,
      ...data,
      status: 'active',
      has_system_access: false,
      invitation_status: 'not_invited'
    })
};

export default employeeImporter;
