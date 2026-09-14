/**
 * Frontend base URL helpers.
 *
 * FRONTEND_URL may be a comma-separated list (CORS-style); public links must
 * use a single origin with no trailing slash. Read at call time rather than
 * module scope so import order can never bake the localhost fallback in.
 */
export function getFrontendBaseUrl() {
  const first = String(process.env.FRONTEND_URL || '').split(',')[0].trim();
  return (first || 'http://localhost:5173').replace(/\/+$/, '');
}

/**
 * Rewrite the origin of a stored public link to the current FRONTEND_URL.
 * Volunteer action links are persisted as absolute URLs at generation time,
 * so a misconfigured env sticks in the DB until regenerated — rebasing on
 * send keeps the token path while correcting the host.
 */
export function rebasePublicLink(link) {
  const s = String(link || '');
  const idx = s.indexOf('/public/');
  return idx >= 0 ? `${getFrontendBaseUrl()}${s.slice(idx)}` : link;
}
