/**
 * Australian financial year window (FY ending 30 June of `fyEnd`).
 * Uses UTC boundaries to keep comparisons consistent.
 */

import { AppError } from '../middleware/errorHandler.js';

function utcDate(y, m0, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(Date.UTC(y, m0, d, hh, mm, ss, ms));
}

export function computeFyWindow(fyEnd) {
  const endYear = Number(fyEnd);
  if (!Number.isFinite(endYear) || endYear < 2000 || endYear > 2100) {
    throw new AppError('Invalid financial year end', 400, 'INVALID_FY_END');
  }
  const start = utcDate(endYear - 1, 6, 1, 0, 0, 0, 0); // 1 Jul
  const end = utcDate(endYear, 5, 30, 23, 59, 59, 999); // 30 Jun
  return { start, end, fyEnd: endYear };
}

export function inWindow(dateValue, win) {
  if (!dateValue) return false;
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(d.getTime())) return false;
  return d >= win.start && d <= win.end;
}

