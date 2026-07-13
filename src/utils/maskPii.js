/**
 * PII masking helpers for logs (LOG-006)
 *
 * Auth paths previously logged plaintext email addresses on failure/OTP flows,
 * which leaks PII into console/log sinks and enables partial user enumeration.
 * Use maskEmail() whenever an address must appear in a log line for debugging.
 *
 *   maskEmail('john.doe@example.com') -> 'j***@e***.com'
 *
 * Enough to correlate entries during debugging, not enough to recover the
 * address or confirm a specific user exists.
 */

export function maskEmail(value) {
  if (value == null) return value;
  const s = String(value);
  const at = s.indexOf('@');
  if (at < 1) return '***';                       // not an email / empty local part
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot >= 0 ? domain.slice(dot) : '';  // includes leading dot
  const domainHead = domain ? domain[0] : '';
  return `${local[0]}***@${domainHead}***${tld}`;
}
