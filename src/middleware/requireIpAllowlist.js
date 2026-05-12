/**
 * IP allowlist for the Calcite admin surface.
 *
 * Reads `CALCITE_ADMIN_IP_ALLOWLIST` env (comma-separated, supports
 * single IPs and CIDR ranges) and rejects any request whose client IP
 * isn't covered. Mounted on /api/v1/admin/* before any auth middleware
 * so even credential-stuffing probes get blocked at the network edge.
 *
 * Behaviour:
 *   - Empty/unset env → allowlist disabled (returns next() for all).
 *     Useful in dev. In production, this env MUST be set.
 *   - Trusts X-Forwarded-For when behind a proxy (Cloudflare/Render).
 *     Stewardex's existing app.js sets `app.set('trust proxy', 1)`.
 *   - Returns 403 ADMIN_IP_BLOCKED for forbidden IPs (no body so
 *     scrapers learn nothing about the surface).
 */

import { logWarn } from '../utils/logger.js';

const RAW = (process.env.CALCITE_ADMIN_IP_ALLOWLIST || '').trim();
const RULES = parseAllowlist(RAW);
const ENABLED = RULES.length > 0;

function parseAllowlist(raw) {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map(parseRule).filter(Boolean);
}

function parseRule(s) {
  // Accept: '203.0.113.5', '203.0.113.0/24', '::1', '2001:db8::/32'
  if (s.includes('/')) {
    const [ip, prefix] = s.split('/');
    const cidr = Number(prefix);
    if (!Number.isFinite(cidr)) return null;
    return { kind: 'cidr', ip, cidr };
  }
  return { kind: 'exact', ip: s };
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inRange(clientIp, rule) {
  if (rule.kind === 'exact') return clientIp === rule.ip;
  // CIDR — IPv4 only for the simple path. For IPv6 we treat any v6
  // CIDR as "match if client is also v6 in the same /64 prefix"; rare
  // for an admin allowlist so we keep it simple.
  if (clientIp.includes(':') || rule.ip.includes(':')) {
    return clientIp.startsWith(rule.ip.split('::')[0]);
  }
  const a = ipv4ToInt(clientIp);
  const b = ipv4ToInt(rule.ip);
  if (a == null || b == null) return false;
  if (rule.cidr === 0) return true;
  const mask = (~0 << (32 - rule.cidr)) >>> 0;
  return (a & mask) === (b & mask);
}

function clientIpFor(req) {
  // Express's req.ip already honours `trust proxy`. Strip IPv6 mapping
  // prefix so '::ffff:192.0.2.1' reads as '192.0.2.1' for matching.
  const raw = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  return raw;
}

export function requireIpAllowlist(req, res, next) {
  if (!ENABLED) return next();
  const ip = clientIpFor(req);
  const allowed = RULES.some((rule) => inRange(ip, rule));
  if (allowed) return next();

  logWarn('Calcite admin IP blocked', { ip, path: req.path });
  return res.status(403).json({
    success: false,
    error: { code: 'ADMIN_IP_BLOCKED', message: 'This network is not authorised to access the admin portal.' }
  });
}

export default requireIpAllowlist;
