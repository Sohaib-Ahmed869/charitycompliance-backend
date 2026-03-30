/**
 * Blocks mutating HTTP methods for auditor (read-only) sessions.
 * Mount after authenticate so req.user.isAuditor is set.
 */
export function auditorWriteGuard(req, res, next) {
  if (!req.user?.isAuditor) return next();
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  return res.status(403).json({
    success: false,
    error: 'Auditor access is read-only. This action is not allowed.'
  });
}
