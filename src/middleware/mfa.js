import jwt from 'jsonwebtoken';

const MFA_JWT_SECRET = process.env.JWT_SECRET;

export function issueMfaToken({ userId, orgId, scope }, ttlSeconds = 600) {
  return jwt.sign(
    { userId, orgId, scope, typ: 'mfa' },
    MFA_JWT_SECRET,
    { expiresIn: ttlSeconds }
  );
}

export function requireMfa(scope) {
  return (req, res, next) => {
    const token = req.headers['x-mfa-token'] || req.headers['x-mfa'] || null;
    if (!token) {
      return res.status(401).json({
        success: false,
        error: { code: 'MFA_REQUIRED', message: 'MFA verification required' }
      });
    }
    try {
      const decoded = jwt.verify(token, MFA_JWT_SECRET);
      if (decoded?.typ !== 'mfa' || decoded?.scope !== scope) {
        return res.status(401).json({
          success: false,
          error: { code: 'MFA_INVALID', message: 'Invalid MFA token' }
        });
      }
      if (req.user?.userId && decoded.userId !== req.user.userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'MFA_INVALID', message: 'Invalid MFA token' }
        });
      }
      next();
    } catch (e) {
      return res.status(401).json({
        success: false,
        error: { code: 'MFA_EXPIRED', message: 'MFA token expired' }
      });
    }
  };
}

