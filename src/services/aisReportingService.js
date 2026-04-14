/**
 * AIS Prefill Service (ACNC Annual Information Statement)
 * Aggregates org + programs + responsible people + cash-basis financial totals.
 */

import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { FundingProgramRepository } from '../repositories/fundingProgramRepository.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { DonationRepository } from '../repositories/donationRepository.js';
import { DonationBoxRepository } from '../repositories/donationBoxRepository.js';
import { ExpenseRepository } from '../repositories/expenseRepository.js';
import { computeFyWindow, inWindow } from '../utils/fyWindow.js';
import { decryptBoardMemberList } from '../utils/decryptBoardMember.js';
import { getMasterKeyHex } from '../config/encryption.js';

const fmtMoney = (n) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(Number(n || 0));

function safeStr(v) {
  return String(v || '').trim();
}

function buildAddress(org) {
  const parts = [
    org?.address_street,
    org?.address_street2,
    org?.address_city,
    org?.address_state,
    org?.address_postcode,
    org?.address_country
  ].map((x) => safeStr(x)).filter(Boolean);
  return parts.join(', ');
}

function boardMemberName(bm) {
  const first = safeStr(bm?.given_names);
  const last = safeStr(bm?.family_name);
  return `${first} ${last}`.trim() || safeStr(bm?.email) || '—';
}

function toIsoDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function donationIncludedAt(d) {
  return d?.submitted_at || d?.createdAt || d?.created_at || null;
}

function boxEntryIsRevenue(e) {
  // v1 cash-basis: completed workflow OR deposit confirmed
  return e?.workflow_status === 'completed' || !!e?.deposit_confirmed_at;
}

function bump(obj, key) {
  const k = String(key || 'unknown');
  obj[k] = (obj[k] || 0) + 1;
}

export async function buildAisPrefill({ tenantDb, orgId, fyEnd }) {
  const win = computeFyWindow(fyEnd);

  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();

  const [programsRaw, responsibleRaw, donationsRaw, boxesRaw, expensesRaw] = await Promise.all([
    new FundingProgramRepository(tenantDb).findAllByOrg(orgId, {}),
    org?._id ? new BoardMemberRepository(tenantDb).findByOrgId(org._id, false, false) : Promise.resolve([]),
    new DonationRepository(tenantDb).findAll({ org_id: orgId, status: 'approved' }),
    new DonationBoxRepository(tenantDb).list({ orgId, status: null, search: '' }),
    new ExpenseRepository(tenantDb).findByOrgId(orgId, {}) // used for paid expense totals
  ]);

  // Decrypt responsible people fields for names/emails.
  const keyHex = getMasterKeyHex();
  const responsiblePeoplePlain = (responsibleRaw || []).map((x) => (x?.toObject ? x.toObject() : x));
  decryptBoardMemberList(responsiblePeoplePlain, keyHex);

  const programs = (programsRaw || []).map((p) => ({
    id: String(p?._id || ''),
    name: safeStr(p?.name),
    description: safeStr(p?.description),
    website_url: safeStr(p?.website_url),
    beneficiaries: safeStr(p?.beneficiaries),
    locations: Array.isArray(p?.locations) ? p.locations.filter(Boolean) : []
  }));

  const responsible_people = responsiblePeoplePlain
    .filter((bm) => bm?.is_board_member === true)
    .map((bm) => ({
    id: String(bm?._id || ''),
    name: boardMemberName(bm),
    position: safeStr(bm?.custom_position_title || bm?.position || ''),
    start_date: toIsoDate(bm?.appointment_date),
    end_date: toIsoDate(bm?.term_end_date)
    }));

  // Donations revenue
  const includedDonations = [];
  const excludedDonations = [];
  const donationExcludedReasons = {};
  let donationsTotal = 0;
  for (const d of donationsRaw || []) {
    const at = donationIncludedAt(d);
    const amt = Number(d?.amount || 0);
    const include = amt > 0 && inWindow(at, win);
    const row = {
      id: String(d?._id || ''),
      title: safeStr(d?.title),
      amount: amt,
      date: toIsoDate(at),
      status: safeStr(d?.status)
    };
    if (include) {
      donationsTotal += amt;
      includedDonations.push(row);
    } else {
      excludedDonations.push(row);
      if (!(amt > 0)) bump(donationExcludedReasons, 'amount_not_positive');
      else if (!at) bump(donationExcludedReasons, 'missing_date');
      else bump(donationExcludedReasons, 'outside_fy');
    }
  }

  // Donation box revenue
  const includedBoxEntries = [];
  const excludedBoxEntries = [];
  const donationBoxExcludedReasons = {};
  let donationBoxesTotal = 0;
  for (const box of boxesRaw || []) {
    const boxId = String(box?._id || '');
    const boxName = safeStr(box?.name);
    for (const e of box?.entries || []) {
      const amt = Number(e?.amount || 0);
      const at = e?.entry_date;
      const include = amt > 0 && inWindow(at, win) && boxEntryIsRevenue(e);
      const row = {
        box_id: boxId,
        box_name: boxName,
        entry_id: String(e?._id || ''),
        amount: amt,
        date: toIsoDate(at),
        workflow_status: safeStr(e?.workflow_status),
        deposit_confirmed_at: toIsoDate(e?.deposit_confirmed_at)
      };
      if (include) {
        donationBoxesTotal += amt;
        includedBoxEntries.push(row);
      } else {
        excludedBoxEntries.push(row);
        if (!(amt > 0)) bump(donationBoxExcludedReasons, 'amount_not_positive');
        else if (!at) bump(donationBoxExcludedReasons, 'missing_date');
        else if (!inWindow(at, win)) bump(donationBoxExcludedReasons, 'outside_fy');
        else bump(donationBoxExcludedReasons, 'not_completed_or_deposited');
      }
    }
  }

  // Expenses (paid only)
  const includedExpenses = [];
  const excludedExpenses = [];
  const expenseExcludedByStatus = {};
  const expenseExcludedReasons = {};
  let expensesTotal = 0;
  for (const exp of expensesRaw || []) {
    const paidAt = exp?.paid_at;
    const amt = Number(exp?.amount || 0);
    const include = exp?.status === 'paid' && amt > 0 && inWindow(paidAt, win);
    const row = {
      id: String(exp?._id || ''),
      title: safeStr(exp?.expense_name || exp?.description),
      amount: amt,
      date: toIsoDate(paidAt || exp?.created_at),
      status: safeStr(exp?.status),
      category: safeStr(exp?.category || '')
    };
    if (include) {
      expensesTotal += amt;
      includedExpenses.push(row);
    } else {
      excludedExpenses.push(row);
      bump(expenseExcludedByStatus, exp?.status || 'unknown');
      if (exp?.status !== 'paid') bump(expenseExcludedReasons, 'status_not_paid');
      else if (!(amt > 0)) bump(expenseExcludedReasons, 'amount_not_positive');
      else if (!paidAt) bump(expenseExcludedReasons, 'missing_paid_date');
      else bump(expenseExcludedReasons, 'outside_fy');
    }
  }

  const revenue = donationsTotal + donationBoxesTotal;
  const net = revenue - expensesTotal;

  return {
    fy: { end_year: win.fyEnd, start_date: toIsoDate(win.start), end_date: toIsoDate(win.end) },
    charity: {
      name: safeStr(org?.name),
      abn: safeStr(org?.abn),
      website: safeStr(org?.website),
      email: safeStr(org?.email),
      address: buildAddress(org),
      logo_url: safeStr(org?.logo_url)
    },
    programs,
    responsible_people,
    financials: {
      revenue,
      revenue_formatted: fmtMoney(revenue),
      donations: donationsTotal,
      donations_formatted: fmtMoney(donationsTotal),
      donation_boxes: donationBoxesTotal,
      donation_boxes_formatted: fmtMoney(donationBoxesTotal),
      expenses: expensesTotal,
      expenses_formatted: fmtMoney(expensesTotal),
      net,
      net_formatted: fmtMoney(net),
      rules: {
        revenue: 'Approved donations + completed/deposit-confirmed donation box entries within FY (cash basis).',
        expenses: 'Paid expenses within FY (cash basis).',
      },
      breakdown: {
        included_donations: includedDonations,
        excluded_donations: excludedDonations,
        excluded_donations_reasons: donationExcludedReasons,
        included_donation_box_entries: includedBoxEntries,
        excluded_donation_box_entries: excludedBoxEntries,
        excluded_donation_box_entries_reasons: donationBoxExcludedReasons,
        included_expenses: includedExpenses,
        excluded_expenses: excludedExpenses,
        excluded_expenses_by_status: expenseExcludedByStatus,
        excluded_expenses_reasons: expenseExcludedReasons,
      }
    }
  };
}

