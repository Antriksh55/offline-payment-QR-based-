const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'offline-payment-demo-secret-change-in-production';

/**
 * requireAuth middleware: validates JWT from Authorization header.
 * Attaches decoded payload to req.user.
 *
 * NOTE: JWT auth gates READ endpoints (balance, history).
 * Transaction validity is independently verified per-transaction via Ed25519 signature
 * in the Switch — never via JWT. A sync call with an expired JWT still processes
 * transactions correctly because the Switch only checks signatures.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'JWT expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Issue a JWT for a user.
 * @param {{ vpa, userId, mobileNumber }} payload
 * @returns {string} signed JWT (1 hour expiry)
 */
function issueToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

module.exports = { requireAuth, issueToken };
