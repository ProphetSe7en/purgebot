// Per-session CSRF tokens.
//
// Token lifecycle:
//   - Issued lazily on first state-changing request (or by /api/auth/csrf).
//   - Stored on req.session.csrf so it survives across requests but is unique
//     per logged-in browser session.
//   - Verified via X-CSRF-Token header (constant-time compare).
//   - GET / HEAD / OPTIONS bypass verification entirely.
//
// Anonymous (unauthenticated) requests on public endpoints (/api/auth/login,
// /api/auth/setup) get a fresh token issued in the response cookie + body
// at the moment they fetch the login/setup page, so the very first POST can
// succeed. This is the standard "double-submit" variant for anon flows.
//
// Why not a library: `csurf` is deprecated; `lusca` mixes too many concerns;
// rolling 60 lines ourselves matches clonarr's hand-rolled csrf.go pattern.

const crypto = require('crypto');

const COOKIE_NAME = 'purgebot_csrf';
const HEADER_NAME = 'x-csrf-token';
const TOKEN_BYTES = 32;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function issueToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function setAnonCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: false, // JS reads it to populate the header
    sameSite: 'lax',
    secure: false,
    path: '/',
    // No maxAge - session-scoped cookie. Lasts until the browser tab closes.
    // For trusted-network anonymous users that means CSRF survives navigation
    // within the SPA but starts fresh on a new browser session.
  });
}

function constantTimeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (_) {
    return false;
  }
}

// Ensures req.session.csrf exists for authenticated sessions.
function ensureSessionToken(req) {
  if (!req.session) return null;
  if (!req.session.csrf) req.session.csrf = issueToken();
  return req.session.csrf;
}

// Express middleware that:
//   1. Skips safe methods.
//   2. For authenticated sessions: requires header to match req.session.csrf.
//   3. For unauthenticated (anon) requests: requires header to match the
//      cookie value (double-submit).
function verifyMiddleware() {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const headerToken = req.get(HEADER_NAME);
    if (!headerToken) {
      return res.status(403).json({ error: 'csrf token missing' });
    }
    // Authenticated session: must match the session-stored token. Don't fall
    // back to anon double-submit when session.csrf is missing - that would
    // silently downgrade an authenticated request to the anon trust model.
    if (req.session?.user) {
      if (!req.session.csrf || !constantTimeEq(headerToken, req.session.csrf)) {
        return res.status(403).json({ error: 'csrf token invalid' });
      }
      return next();
    }
    // Anonymous: cookie double-submit.
    const cookieToken = req.cookies?.[COOKIE_NAME];
    if (!cookieToken || !constantTimeEq(headerToken, cookieToken)) {
      return res.status(403).json({ error: 'csrf token invalid' });
    }
    return next();
  };
}

// Endpoint handler: returns the current CSRF token. For authenticated
// sessions, returns req.session.csrf (creating one if missing). For anon
// requests (used by login/setup pages), generates a fresh cookie + value.
function tokenHandler() {
  return (req, res) => {
    if (req.session?.user) {
      const token = ensureSessionToken(req);
      return res.json({ token });
    }
    const fresh = issueToken();
    setAnonCookie(res, fresh);
    return res.json({ token: fresh });
  };
}

module.exports = {
  COOKIE_NAME,
  HEADER_NAME,
  issueToken,
  ensureSessionToken,
  setAnonCookie,
  verifyMiddleware,
  tokenHandler,
  constantTimeEq,
};
