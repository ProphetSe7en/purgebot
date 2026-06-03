const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { log } = require('../bot');

const { AuthStore } = require('./auth');
const { Limiter } = require('./ratelimit');
const csrf = require('./csrf');
const audit = require('./audit');

const configRoutes = require('./routes/config');
const statsRoutes = require('./routes/stats');
const controlRoutes = require('./routes/control');
const logsRoutes = require('./routes/logs');
const webhooksRoutes = require('./routes/webhooks');

const UI_PORT = parseInt(process.env.UI_PORT || '3050', 10);
const CONFIG_DIR = process.env.PURGEBOT_CONFIG_DIR || '/config';
const VIEWS_DIR = path.join(__dirname, 'views');

function startServer() {
  // Initialise auth store from env + on-disk creds.
  const auth = new AuthStore({ configDir: CONFIG_DIR, env: process.env, logger: log });
  auth.init();

  const apiLimiter = new Limiter({ burst: 30, refillPerSec: 2, name: 'api', logger: log });
  const loginLimiter = new Limiter({ burst: 5, refillPerSec: 1 / 60, name: 'login', logger: log });

  log('INFO', `Auth requirement: ${auth.requirement}${auth.isFirstRun() ? ' (first-run, /setup required)' : ''}`);
  if (auth.trustedNetworksLocked) log('INFO', `TRUSTED_NETWORKS locked via env: ${auth.trustedNetworks.raw}`);
  if (auth.trustedProxiesLocked) log('INFO', `TRUSTED_PROXIES locked via env: ${auth.trustedProxies.raw}`);

  const app = express();

  // We honour X-Forwarded-For via auth.clientIp() ourselves. Disable
  // express's own trust-proxy resolution to avoid double-handling.
  app.set('trust proxy', false);

  app.use(cookieParser());
  app.use(auth.sessionMiddleware());
  app.use(express.json({ limit: '50kb' }));

  // ---- Healthcheck - no auth, no rate-limit (used by Docker) ----
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---- CSRF token endpoint (anon-allowed) ----
  app.get('/api/auth/csrf', csrf.tokenHandler());

  // ---- Rate limits applied BEFORE handlers ----
  // General /api/* rate-limit. Mounting here means anonymous requests are
  // counted too - fine, the burst is generous enough for normal UI flow.
  app.use('/api', apiLimiter.middleware(req => auth.clientIp(req), ({ key, retryAfterSec }) => {
    log('WARN', `Rate-limit hit on /api from ${key} (retry ${retryAfterSec}s)`);
  }));
  // Stricter limits on credential endpoints.
  app.use('/api/auth/login', loginLimiter.middleware(req => auth.clientIp(req), ({ key, retryAfterSec }) => {
    log('WARN', `Login rate-limit hit from ${key} (retry ${retryAfterSec}s)`);
    audit.record('auth.ratelimit', {
      actor: { kind: 'anonymous' }, ip: key,
      details: { endpoint: '/api/auth/login', retryAfterSec },
    });
  }));
  app.use('/api/auth/setup', loginLimiter.middleware(req => auth.clientIp(req), ({ key, retryAfterSec }) => {
    log('WARN', `Setup rate-limit hit from ${key} (retry ${retryAfterSec}s)`);
    audit.record('auth.ratelimit', {
      actor: { kind: 'anonymous' }, ip: key,
      details: { endpoint: '/api/auth/setup', retryAfterSec },
    });
  }));
  // Same stricter bucket on credential-verifying endpoints so a stolen
  // session cookie cannot brute-force the password under the lax /api/*
  // limit (which allows ~120 attempts/min).
  app.use('/api/auth/api-key/rotate', loginLimiter.middleware(req => auth.clientIp(req), ({ key, retryAfterSec }) => {
    log('WARN', `API key rotate rate-limit hit from ${key} (retry ${retryAfterSec}s)`);
    audit.record('auth.ratelimit', {
      actor: { kind: 'anonymous' }, ip: key,
      details: { endpoint: '/api/auth/api-key/rotate', retryAfterSec },
    });
  }));
  app.use('/api/auth/change-password', loginLimiter.middleware(req => auth.clientIp(req), ({ key, retryAfterSec }) => {
    log('WARN', `Password change rate-limit hit from ${key} (retry ${retryAfterSec}s)`);
    audit.record('auth.ratelimit', {
      actor: { kind: 'anonymous' }, ip: key,
      details: { endpoint: '/api/auth/change-password', retryAfterSec },
    });
  }));

  // ---- CSRF verification on state-changing /api/* requests ----
  app.use('/api', csrf.verifyMiddleware());

  // ---- Public auth endpoints (handled before requireAuth gate) ----
  app.post('/api/auth/setup', async (req, res) => {
    const ip = auth.clientIp(req);
    if (!auth.isFirstRun()) {
      return res.status(409).json({ error: 'already configured' });
    }
    const { username, password } = req.body || {};
    const result = auth.setupInitialCreds({ username, password });
    if (!result.ok) {
      log('WARN', `Setup attempt rejected from ${ip}: ${result.error}`);
      audit.record('auth.setup_rejected', {
        actor: { kind: 'anonymous' }, ip,
        details: { reason: result.error },
      });
      return res.status(400).json({ error: result.error });
    }
    auth.loginSession(req, username, (err) => {
      if (err) {
        log('WARN', `Session establish failed after setup: ${err.message}`);
        audit.record('auth.setup_session_failed', {
          actor: { kind: 'user', name: username }, ip,
          details: { error: err.message },
        });
        return res.status(500).json({ error: 'setup ok but session establish failed' });
      }
      audit.record('auth.setup_complete', {
        actor: { kind: 'user', name: username }, ip,
      });
      res.json({ ok: true });
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    const ip = auth.clientIp(req);
    if (auth.isFirstRun()) {
      return res.status(409).json({ error: 'setup required' });
    }
    const ok = await auth.checkLogin({ username, password });
    if (!ok) {
      // Log failure but keep response opaque (no username-leak via 401 vs 404)
      const uaTrim = String(req.get('user-agent') || '').slice(0, 200);
      log('WARN', `Login failed from ${ip} (ua=${JSON.stringify(uaTrim)})`);
      audit.record('auth.login_failure', {
        actor: { kind: 'anonymous' }, ip,
        details: { userAgent: uaTrim },
      });
      return res.status(401).json({ error: 'invalid username or password' });
    }
    auth.loginSession(req, username, (err) => {
      if (err) {
        log('WARN', `Session establish failed after login: ${err.message}`);
        return res.status(500).json({ error: 'login ok but session establish failed' });
      }
      log('INFO', `Login success: user="${username}" ip=${ip}`);
      audit.record('auth.login_success', {
        actor: { kind: 'user', name: username }, ip,
      });
      res.json({ ok: true });
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const u = auth.sessionUser(req)?.username || 'unknown';
    const ip = auth.clientIp(req);
    auth.logoutSession(req, () => {
      log('INFO', `Logout: user="${u}"`);
      audit.record('auth.logout', {
        actor: { kind: 'user', name: u }, ip,
      });
      res.clearCookie(require('./auth').SESSION_COOKIE_NAME);
      res.clearCookie(csrf.COOKIE_NAME, { path: '/' });
      res.json({ ok: true });
    });
  });

  app.get('/api/auth/me', (req, res) => {
    const user = auth.sessionUser(req);
    res.json({
      authenticated: !!user,
      user,
      requirement: auth.requirement,
      hasCreds: auth.hasCreds(),
      firstRun: auth.isFirstRun(),
      trustedBypass: !auth.authRequiredFor(req),
    });
  });

  // The following three endpoints require a REAL session (not LAN-bypass).
  // API keys + password changes are sensitive enough that we require explicit
  // login even on the LAN, mirroring clonarr's posture.
  function requireRealSession(req, res, next) {
    if (!auth.isSessionAuthenticated(req)) {
      return res.status(401).json({ error: 'login required for this action' });
    }
    next();
  }

  app.get('/api/auth/api-key', requireRealSession, (req, res) => {
    const key = auth.apiKey();
    if (!key) return res.status(404).json({ error: 'no api key configured' });
    res.json({ apiKey: key });
  });

  app.post('/api/auth/api-key/rotate', requireRealSession, async (req, res) => {
    const { currentPassword } = req.body || {};
    const ip = auth.clientIp(req);
    const username = auth.sessionUser(req).username;
    const ok = await auth.checkLogin({ username, password: currentPassword });
    if (!ok) {
      log('WARN', `API key rotate rejected (bad current password) user="${username}" ip=${ip}`);
      audit.record('auth.api_key_rotate_rejected', {
        actor: { kind: 'user', name: username }, ip,
        details: { reason: 'bad current password' },
      });
      return res.status(403).json({ error: 'current password incorrect' });
    }
    const fresh = auth.rotateApiKey();
    if (!fresh) return res.status(500).json({ error: 'rotation failed' });
    log('INFO', `API key rotated by user="${username}" ip=${ip}`);
    audit.record('auth.api_key_rotated', {
      actor: { kind: 'user', name: username }, ip,
    });
    res.json({ apiKey: fresh });
  });

  app.post('/api/auth/change-password', requireRealSession, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const ip = auth.clientIp(req);
    const username = auth.sessionUser(req).username;
    const result = await auth.changePassword({ currentPassword, newPassword });
    if (!result.ok) {
      log('WARN', `Password change rejected user="${username}" ip=${ip}: ${result.error}`);
      audit.record('auth.password_change_rejected', {
        actor: { kind: 'user', name: username }, ip,
        details: { reason: result.error },
      });
      return res.status(400).json({ error: result.error });
    }
    log('INFO', `Password changed by user="${username}" ip=${ip}`);
    audit.record('auth.password_changed', {
      actor: { kind: 'user', name: username }, ip,
    });
    res.json({ ok: true });
  });

  // ---- Static auth assets + login/setup pages (public) ----
  app.get('/auth-assets/auth-shared.css', (req, res) => {
    res.type('text/css').sendFile(path.join(VIEWS_DIR, 'auth-shared.css'));
  });

  app.get('/login', (req, res) => {
    if (auth.isFirstRun()) return res.redirect('/setup');
    if (auth.isSessionAuthenticated(req)) return res.redirect('/');
    res.type('text/html').sendFile(path.join(VIEWS_DIR, 'login.html'));
  });

  app.get('/setup', (req, res) => {
    if (!auth.isFirstRun()) return res.redirect('/login');
    res.type('text/html').sendFile(path.join(VIEWS_DIR, 'setup.html'));
  });

  // ---- Auth gate: everything below requires session, API-key, or trusted-network bypass ----
  app.use(auth.requireAuth());

  // ---- Authenticated API routes ----
  app.use('/api/config', configRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/cleanup', controlRoutes);
  app.use('/api/logs', logsRoutes);
  app.use('/api/webhooks', webhooksRoutes);

  // ---- Authenticated SPA ----
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  const server = app.listen(UI_PORT, () => {
    log('INFO', `Web UI available at http://0.0.0.0:${UI_PORT}`);
  });

  // Expose auth on the server object so other modules / tests can introspect.
  server.auth = auth;
  return server;
}

module.exports = { startServer };
