/**
 * BAS (Business Activity Statement) periods stored as Documents
 * (category `bas_lodgement`, document_type `bas_period_quarterly`).
 * Periods are created only when a user uploads a file — no server-side auto-generation.
 *
 * Australian GST quarters within FY ending `financialYearEnd` (30 June of that year).
 */

import { AppError } from '../middleware/errorHandler.js';

export const BAS_QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];

function utcDate(y, m0, d) {
  return new Date(Date.UTC(y, m0, d, 0, 0, 0, 0));
}

function endOfDayUtc(y, m0, d) {
  return new Date(Date.UTC(y, m0, d, 23, 59, 59, 999));
}

/**
 * @param {number} financialYearEnd - calendar year in which 30 June falls for this FY
 * @param {'Q1'|'Q2'|'Q3'|'Q4'} quarter
 */
export function computeBasQuarterWindow(financialYearEnd, quarter) {
  const fyStartYear = financialYearEnd - 1;
  if (quarter === 'Q1') {
    return {
      period_start: utcDate(fyStartYear, 6, 1),
      period_end: endOfDayUtc(fyStartYear, 8, 30),
      due_date: endOfDayUtc(fyStartYear, 9, 28)
    };
  }
  if (quarter === 'Q2') {
    return {
      period_start: utcDate(fyStartYear, 9, 1),
      period_end: endOfDayUtc(fyStartYear, 11, 31),
      due_date: endOfDayUtc(financialYearEnd, 1, 28)
    };
  }
  if (quarter === 'Q3') {
    return {
      period_start: utcDate(financialYearEnd, 0, 1),
      period_end: endOfDayUtc(financialYearEnd, 2, 31),
      due_date: endOfDayUtc(financialYearEnd, 3, 28)
    };
  }
  if (quarter === 'Q4') {
    return {
      period_start: utcDate(financialYearEnd, 3, 1),
      period_end: endOfDayUtc(financialYearEnd, 5, 30),
      due_date: endOfDayUtc(financialYearEnd, 6, 28)
    };
  }
  throw new AppError('Invalid BAS quarter', 400, 'INVALID_BAS_QUARTER');
}

export function basPeriodKey(financialYearEnd, quarter) {
  return `BAS-${financialYearEnd}-${quarter}`;
}

export function buildBasPeriodMetadata(rawMeta) {
  const base = typeof rawMeta === 'object' && rawMeta ? { ...rawMeta } : {};
  const fy = Number(base.financial_year_end);
  const q = String(base.quarter || '').toUpperCase();
  if (!Number.isFinite(fy) || !BAS_QUARTERS.includes(q)) {
    throw new AppError(
      'For BAS lodgement, metadata.financial_year_end (June year) and metadata.quarter (Q1–Q4) are required.',
      400,
      'INVALID_BAS_PERIOD'
    );
  }
  const { period_start, period_end, due_date } = computeBasQuarterWindow(fy, q);
  base.financial_year_end = fy;
  base.quarter = q;
  base.period_key = basPeriodKey(fy, q);
  base.period_start = period_start.toISOString();
  base.period_end = period_end.toISOString();
  base.due_date = due_date.toISOString();
  base.gst_collected = base.gst_collected ?? null;
  base.gst_paid = base.gst_paid ?? null;
  base.payg_withheld = base.payg_withheld ?? null;
  base.net_amount = base.net_amount ?? null;
  base.ato_reference = base.ato_reference ?? '';
  return base;
}
