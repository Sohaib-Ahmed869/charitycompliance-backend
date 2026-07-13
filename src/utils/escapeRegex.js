/**
 * Escape a user-supplied string for safe LITERAL use inside a RegExp.
 *
 * SECURITY (API-025 / API-027 / MDB-020): search/filter values are compiled into
 * `new RegExp(value, 'i')` in many repositories. Un-escaped, a value like
 * `(a+)+$` causes catastrophic backtracking (ReDoS) and metacharacters change
 * the query's meaning (regex injection). Wrapping the value with this makes it
 * a plain substring match.
 *
 * @param {*} value
 * @returns {string} regex-safe literal
 */
export function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default escapeRegex;
