/**
 * sanitizeMongo — strip MongoDB operator injection from request input.
 *
 * SECURITY (INP-002): a JSON body is an object-shaped channel, so a value like
 * `{ "$ne": null }` (or a key containing a dot) can smuggle query operators into
 * a `findOne(...)` filter and turn an equality lookup into "match anything" —
 * e.g. the password-reset token check. We recursively remove any object key that
 * starts with `$` or contains `.` from the request body (and best-effort query).
 *
 * Express-5-safe: `req.body` is a normal mutable object, so we scrub it in place.
 * `req.query` is a read-only getter in Express 5 — we scrub its keys best-effort
 * inside a try/catch and never reassign it. URL params are always strings, so
 * they can't carry operators and are left alone.
 *
 * This is defence-in-depth: individual handlers should STILL type-check their
 * inputs (a string token is a string), but this guarantees no `$`/dotted key
 * ever reaches a query builder, app-wide.
 */

const isObject = (v) => v !== null && typeof v === 'object';

function scrub(value, depth = 0) {
  if (depth > 30 || !isObject(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) scrub(item, depth + 1);
    return value;
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete value[key];
      continue;
    }
    scrub(value[key], depth + 1);
  }
  return value;
}

export function sanitizeMongo(req, _res, next) {
  if (isObject(req.body)) scrub(req.body);
  // req.query may be a read-only getter (Express 5) — scrub in place if we can.
  try { if (isObject(req.query)) scrub(req.query); } catch { /* immutable query — ignore */ }
  next();
}

// Exported for unit tests.
export { scrub as _scrubMongoOperators };

export default sanitizeMongo;
