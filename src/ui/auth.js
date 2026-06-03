// PurgeBot auth module - Node.js port of clonarr's internal/auth/auth.go
// Same defaults, same env-vars, same on-disk shape. Fleet-parity intentional.
//
// Storage:
//   /config/auth.json       creds (mode 600): username, passwordHash, apiKey, createdAt
//   /config/sessions.json   active sessions (mode 600): sid -> { expires, userdata, cookie }
//   /config/session-secret  HMAC key for express-session cookie signing (mode 600)
//
// Env vars (read once at startup):
//   AUTH_REQUIRED          'enabled' | 'disabled_for_local_addresses' (default)
//   TRUSTED_NETWORKS       CSV of CIDRs that bypass auth in 'disabled_for_local_addresses' mode.
//                          Empty => default set (loopback + RFC1918 + link-local + ULA).
//   TRUSTED_PROXIES        CSV of CIDRs whose X-Forwarded-For headers we trust.
//
// Lockable env semantics: when AUTH_REQUIRED / TRUSTED_NETWORKS / TRUSTED_PROXIES
// are set via env, the matching UI form fields are read-only so a session-hijack
// attacker cannot expand the trust boundary without host-level access.

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const session = require('express-session');

const REQUIRE_ALL = 'enabled';
const REQUIRE_EXT_LOCAL = 'disabled_for_local_addresses';

const SESSION_COOKIE_NAME = 'purgebot_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_COST = 12;
const BCRYPT_MAX_BYTES = 72;
const PASSWORD_MIN_CHARS = 8;
const PASSWORD_SKIP_CLASS_CHECK_AT = 16;

const DEFAULT_TRUSTED_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

// Paths that bypass auth entirely (login flow, static auth assets, healthcheck).
// Every other path is gated when auth is required.
const PUBLIC_PATH_PREFIXES = [
  '/login',
  '/setup',
  '/logout',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/csrf',
  '/healthz',
  '/favicon.ico',
];

const PUBLIC_STATIC_PREFIXES = [
  '/vendor/',
  '/static/',
];

function isPublicPath(p) {
  if (!p) return false;
  for (const prefix of PUBLIC_PATH_PREFIXES) {
    if (p === prefix || p.startsWith(prefix + '/') || p.startsWith(prefix + '?')) return true;
  }
  for (const prefix of PUBLIC_STATIC_PREFIXES) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

// ---- CIDR parsing + classification ----

function parseCidrList(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (items.length === 0) return null;
  const blocklist = new net.BlockList();
  const entries = [];
  const invalid = [];
  for (const item of items) {
    try {
      const slash = item.indexOf('/');
      const addr = slash === -1 ? item : item.substring(0, slash);
      const family = addr.includes(':') ? 'ipv6' : 'ipv4';
      const prefix = slash === -1
        ? (family === 'ipv6' ? 128 : 32)
        : parseInt(item.substring(slash + 1), 10);
      if (Number.isNaN(prefix)) throw new Error('invalid prefix');
      if (slash === -1) {
        blocklist.addAddress(addr, family);
      } else {
        blocklist.addSubnet(addr, prefix, family);
      }
      entries.push(item);
    } catch (_) {
      invalid.push(item);
    }
  }
  return { blocklist, entries, raw, invalid };
}

function ipMatchesBlocklist(blocklist, ip) {
  if (!blocklist || !ip) return false;
  let normalized = ip;
  // Strip IPv4-mapped-in-IPv6 prefix (Node sometimes reports ::ffff:1.2.3.4)
  if (normalized.startsWith('::ffff:') && normalized.indexOf('.') !== -1) {
    normalized = normalized.substring(7);
  }
  const family = normalized.includes(':') ? 'ipv6' : 'ipv4';
  try {
    return blocklist.check(normalized, family);
  } catch (_) {
    return false;
  }
}

// ---- Password handling ----

function hashPassword(plain) {
  if (typeof plain !== 'string') throw new Error('password must be a string');
  if (Buffer.byteLength(plain, 'utf8') > BCRYPT_MAX_BYTES) {
    throw new Error(`password is longer than ${BCRYPT_MAX_BYTES} bytes (bcrypt limit)`);
  }
  return bcrypt.hashSync(plain, BCRYPT_COST);
}

async function verifyPassword(plain, hash) {
  if (typeof plain !== 'string' || typeof hash !== 'string') return false;
  // Enforce the same 72-byte cap on the verify path so an attacker cannot
  // bypass length restrictions or measure response time on oversize inputs.
  if (Buffer.byteLength(plain, 'utf8') > BCRYPT_MAX_BYTES) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch (_) {
    return false;
  }
}

function validatePassword(plain) {
  if (typeof plain !== 'string' || plain.length < PASSWORD_MIN_CHARS) {
    return `Password must be at least ${PASSWORD_MIN_CHARS} characters`;
  }
  if (Buffer.byteLength(plain, 'utf8') > BCRYPT_MAX_BYTES) {
    return `Password must be no more than ${BCRYPT_MAX_BYTES} bytes`;
  }
  // 16+ chars skip the class-mix requirement (passphrase-friendly)
  if (plain.length >= PASSWORD_SKIP_CLASS_CHECK_AT) return null;
  // Otherwise require at least two of: lower, upper, digit, symbol
  const classes = [
    /[a-z]/.test(plain),
    /[A-Z]/.test(plain),
    /[0-9]/.test(plain),
    /[^A-Za-z0-9]/.test(plain),
  ].filter(Boolean).length;
  if (classes < 2) {
    return 'Password under 16 chars must mix at least two of: lowercase, uppercase, digit, symbol';
  }
  return null;
}

function validateUsername(name) {
  if (typeof name !== 'string') return 'Username required';
  const trimmed = name.trim();
  if (trimmed.length < 1) return 'Username required';
  if (trimmed.length > 64) return 'Username too long (max 64)';
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return 'Username may contain only letters, digits, dot, underscore, hyphen';
  }
  return null;
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

// ---- File-backed session store for express-session ----

class FileSessionStore extends session.Store {
  constructor({ filePath, logger }) {
    super();
    this.filePath = filePath;
    this.logger = logger || (() => {});
    this.sessions = new Map();
    this._writeTimer = null;
    this._loadSync();
  }

  _loadSync() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const obj = JSON.parse(raw);
      const now = Date.now();
      let kept = 0, dropped = 0;
      for (const [sid, entry] of Object.entries(obj || {})) {
        const expires = entry?.cookie?.expires ? new Date(entry.cookie.expires).getTime() : 0;
        if (expires && expires < now) { dropped++; continue; }
        this.sessions.set(sid, entry);
        kept++;
      }
      this.logger('INFO', `Sessions loaded: ${kept} active, ${dropped} expired dropped`);
    } catch (err) {
      this.logger('WARN', `Failed to load sessions (continuing fresh): ${err.message}`);
    }
  }

  _scheduleWrite() {
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this._persistSync();
    }, 200);
  }

  _persistSync() {
    try {
      const obj = {};
      for (const [sid, entry] of this.sessions) obj[sid] = entry;
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      this.logger('WARN', `Failed to persist sessions: ${err.message}`);
    }
  }

  get(sid, cb) {
    const entry = this.sessions.get(sid);
    if (!entry) return cb(null, null);
    const expires = entry?.cookie?.expires ? new Date(entry.cookie.expires).getTime() : 0;
    if (expires && expires < Date.now()) {
      this.sessions.delete(sid);
      this._scheduleWrite();
      return cb(null, null);
    }
    cb(null, entry);
  }

  set(sid, sess, cb) {
    // Deep clone to detach from caller's reference
    this.sessions.set(sid, JSON.parse(JSON.stringify(sess)));
    this._scheduleWrite();
    cb && cb(null);
  }

  destroy(sid, cb) {
    this.sessions.delete(sid);
    this._scheduleWrite();
    cb && cb(null);
  }

  touch(sid, sess, cb) {
    const existing = this.sessions.get(sid);
    if (existing) {
      existing.cookie = sess.cookie;
      this._scheduleWrite();
    }
    cb && cb(null);
  }

  all(cb) {
    cb(null, Array.from(this.sessions.values()));
  }

  length(cb) {
    cb(null, this.sessions.size);
  }

  clear(cb) {
    this.sessions.clear();
    this._scheduleWrite();
    cb && cb(null);
  }
}

// ---- Auth store ----

function readEnvRequirement(env) {
  const raw = String(env?.AUTH_REQUIRED || '').trim().toLowerCase();
  if (raw === REQUIRE_ALL || raw === 'required' || raw === 'enabled') return REQUIRE_ALL;
  return REQUIRE_EXT_LOCAL; // default = LAN-bypass
}

class AuthStore {
  constructor({ configDir, env, logger } = {}) {
    const e = env || process.env;
    this.configDir = configDir || '/config';
    this.authFile = path.join(this.configDir, 'auth.json');
    this.sessionsFile = path.join(this.configDir, 'sessions.json');
    this.secretFile = path.join(this.configDir, 'session-secret');
    this.logger = logger || ((lvl, msg) => console.log(`[${lvl}] ${msg}`));

    this.requirement = readEnvRequirement(e);

    const trustedRaw = e.TRUSTED_NETWORKS;
    const proxiesRaw = e.TRUSTED_PROXIES;
    this.trustedNetworks = parseCidrList(trustedRaw) || parseCidrList(DEFAULT_TRUSTED_CIDRS.join(','));
    this.trustedNetworksLocked = !!trustedRaw && trustedRaw.trim().length > 0;
    this.trustedProxies = parseCidrList(proxiesRaw);
    this.trustedProxiesLocked = !!proxiesRaw && proxiesRaw.trim().length > 0;

    this.creds = null;
    this.sessionSecret = null;
  }

  // Lazily load creds + session secret. Call once at startup.
  init() {
    this._ensureSessionSecret();
    this._loadCreds();
    if (this.trustedNetworks?.invalid?.length > 0) {
      this.logger('WARN', `TRUSTED_NETWORKS contains invalid entries: ${this.trustedNetworks.invalid.join(', ')}`);
    }
    if (this.trustedProxies?.invalid?.length > 0) {
      this.logger('WARN', `TRUSTED_PROXIES contains invalid entries: ${this.trustedProxies.invalid.join(', ')}`);
    }
  }

  _ensureSessionSecret() {
    try {
      if (fs.existsSync(this.secretFile)) {
        const buf = fs.readFileSync(this.secretFile);
        if (buf.length >= 32) {
          this.sessionSecret = buf.toString('utf8');
          return;
        }
      }
    } catch (_) {}
    // Generate fresh secret
    this.sessionSecret = crypto.randomBytes(48).toString('base64url');
    try {
      fs.writeFileSync(this.secretFile, this.sessionSecret, { mode: 0o600 });
    } catch (err) {
      this.logger('WARN', `Failed to persist session secret (sessions will reset on restart): ${err.message}`);
    }
  }

  _loadCreds() {
    try {
      if (!fs.existsSync(this.authFile)) {
        this.creds = null;
        return;
      }
      const obj = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
      if (!obj || typeof obj !== 'object') throw new Error('not an object');
      if (!obj.username || !obj.passwordHash || !obj.apiKey) {
        // Structurally invalid auth file - refuse to silently treat as "unconfigured"
        // so a file-write attacker cannot trigger setup-wizard reset.
        throw new Error('auth file present but missing required fields');
      }
      this.creds = {
        username: String(obj.username),
        passwordHash: String(obj.passwordHash),
        apiKey: String(obj.apiKey),
        createdAt: obj.createdAt || null,
      };
    } catch (err) {
      this.logger('ERROR', `Refusing to start with malformed auth file: ${err.message}`);
      throw err;
    }
  }

  hasCreds() {
    return !!this.creds;
  }

  isFirstRun() {
    return !this.creds;
  }

  authFilePath() {
    return this.authFile;
  }

  sessionsFilePath() {
    return this.sessionsFile;
  }

  // Returns { ok: boolean, error?: string } - sync because bcrypt.hashSync is sync.
  // The _settingUp flag serialises concurrent setup attempts during the
  // first-run window so a second client can't silently overwrite the first.
  setupInitialCreds({ username, password }) {
    if (this.creds || this._settingUp) return { ok: false, error: 'already configured' };
    this._settingUp = true;
    try {
      const userErr = validateUsername(username);
      if (userErr) return { ok: false, error: userErr };
      const pwErr = validatePassword(password);
      if (pwErr) return { ok: false, error: pwErr };
      let passwordHash;
      try {
        passwordHash = hashPassword(password);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      const creds = {
        username: username.trim(),
        passwordHash,
        apiKey: generateApiKey(),
        createdAt: new Date().toISOString(),
      };
      try {
        const tmp = this.authFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.authFile);
      } catch (err) {
        return { ok: false, error: `failed to write auth file: ${err.message}` };
      }
      this.creds = creds;
      this.logger('INFO', `First-run setup complete for user "${creds.username}"`);
      return { ok: true };
    } finally {
      this._settingUp = false;
    }
  }

  // Returns true on match. Always runs bcrypt.compare (constant-ish time)
  // even when username is wrong so attackers cannot probe usernames.
  async checkLogin({ username, password }) {
    const dummyHash = '$2b$12$........................................................';
    if (!this.creds) {
      await verifyPassword(password || '', dummyHash);
      return false;
    }
    // Compare on UTF-8 byte representations so multi-byte usernames don't
    // throw inside timingSafeEqual (which requires equal byte lengths).
    // Reject anything that won't fit a 64-byte slot to keep the compare
    // window bounded; validateUsername caps inputs to 64 code points but a
    // 64-emoji name could still exceed the byte budget - refuse it here.
    let userMatch = false;
    if (typeof username === 'string') {
      const userBuf = Buffer.from(username, 'utf8');
      const credBuf = Buffer.from(this.creds.username, 'utf8');
      if (userBuf.length <= 64 && credBuf.length <= 64) {
        const a = Buffer.alloc(64);
        const b = Buffer.alloc(64);
        userBuf.copy(a);
        credBuf.copy(b);
        try { userMatch = crypto.timingSafeEqual(a, b); }
        catch (_) { userMatch = false; }
      }
    }
    const pwMatch = await verifyPassword(password, this.creds.passwordHash);
    return userMatch && pwMatch;
  }

  // Constant-time API-key compare
  checkApiKey(provided) {
    if (!this.creds || typeof provided !== 'string') return false;
    if (provided.length !== this.creds.apiKey.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(provided),
      Buffer.from(this.creds.apiKey),
    );
  }

  apiKey() {
    return this.creds?.apiKey || null;
  }

  // Rotate the API key. Returns the new key on success.
  rotateApiKey() {
    if (!this.creds) return null;
    const fresh = generateApiKey();
    const next = { ...this.creds, apiKey: fresh };
    try {
      const tmp = this.authFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.authFile);
    } catch (err) {
      this.logger('ERROR', `Failed to write rotated API key: ${err.message}`);
      return null;
    }
    this.creds = next;
    return fresh;
  }

  // Change password. New password is validated the same as setup.
  async changePassword({ currentPassword, newPassword }) {
    if (!this.creds) return { ok: false, error: 'not configured' };
    const verified = await verifyPassword(currentPassword, this.creds.passwordHash);
    if (!verified) return { ok: false, error: 'current password incorrect' };
    const pwErr = validatePassword(newPassword);
    if (pwErr) return { ok: false, error: pwErr };
    let nextHash;
    try { nextHash = hashPassword(newPassword); }
    catch (err) { return { ok: false, error: err.message }; }
    const next = { ...this.creds, passwordHash: nextHash };
    try {
      const tmp = this.authFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.authFile);
    } catch (err) {
      return { ok: false, error: `failed to write auth file: ${err.message}` };
    }
    this.creds = next;
    return { ok: true };
  }

  // ---- Request classification helpers ----

  // Real client IP, honoring TRUSTED_PROXIES + X-Forwarded-For chain.
  clientIp(req) {
    const direct = (req.socket?.remoteAddress || req.ip || '').replace(/^::ffff:/, '');
    if (!this.trustedProxies) return direct;
    // Walk X-Forwarded-For right-to-left, skipping trusted-proxy hops.
    const xff = req.headers['x-forwarded-for'];
    if (!xff) return direct;
    const hops = String(xff).split(',').map(s => s.trim().replace(/^::ffff:/, '')).filter(Boolean);
    // Append the direct peer to the chain so the rightmost hop is checked too.
    const chain = [...hops, direct];
    // Walk right-to-left; first non-trusted address is the client.
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!ipMatchesBlocklist(this.trustedProxies.blocklist, chain[i])) {
        return chain[i];
      }
    }
    return chain[0]; // all hops were trusted proxies - return leftmost
  }

  isTrustedNetwork(ip) {
    return ipMatchesBlocklist(this.trustedNetworks?.blocklist, ip);
  }

  // Returns true when auth must be enforced for this request.
  // - Always enforced if AUTH_REQUIRED=enabled
  // - In disabled_for_local_addresses mode, requests from trusted networks bypass.
  authRequiredFor(req) {
    if (this.requirement === REQUIRE_ALL) return true;
    const ip = this.clientIp(req);
    return !this.isTrustedNetwork(ip);
  }

  // ---- Express integration ----

  sessionMiddleware() {
    const store = new FileSessionStore({ filePath: this.sessionsFile, logger: this.logger });
    this.sessionStore = store;
    return session({
      name: SESSION_COOKIE_NAME,
      secret: this.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true, // refresh expiry on activity
      store,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        // secure flag: only set when serving HTTPS. Browsers reject Secure cookies on HTTP.
        // We let the deployer handle TLS at the proxy; the cookie itself is not Secure-pinned.
        secure: false,
        maxAge: SESSION_TTL_MS,
      },
    });
  }

  // Mark session as authenticated. Regenerates the session ID first so any
  // pre-login state (anon CSRF token, fixation attempts) is dropped. Callback
  // is fired after the regenerated session is persisted to the store.
  loginSession(req, username, cb) {
    const done = cb || (() => {});
    req.session.regenerate((err) => {
      if (err) return done(err);
      req.session.user = { username, loggedInAt: Date.now() };
      req.session.save(done);
    });
  }

  logoutSession(req, cb) {
    req.session.destroy((err) => {
      if (cb) cb(err);
    });
  }

  isSessionAuthenticated(req) {
    return !!(req.session && req.session.user);
  }

  sessionUser(req) {
    return req.session?.user || null;
  }

  // Express middleware: gates routes per authRequiredFor + isPublicPath.
  // Stamps req.authContext for downstream handlers.
  // On HTML routes, redirects to /login; on API routes, returns 401 JSON.
  requireAuth() {
    return (req, res, next) => {
      const sessionAuthed = this.isSessionAuthenticated(req);
      const apiKey = req.headers['x-api-key'] || (req.query.apiKey ? String(req.query.apiKey) : '');
      const apiKeyAuthed = apiKey && this.checkApiKey(apiKey);
      const trustedBypass = !this.authRequiredFor(req);

      req.authContext = {
        ip: this.clientIp(req),
        sessionAuthed,
        apiKeyAuthed,
        trustedBypass,
        user: sessionAuthed ? this.sessionUser(req) : (apiKeyAuthed ? { username: 'api-key' } : null),
      };

      if (sessionAuthed || apiKeyAuthed || trustedBypass) return next();
      if (isPublicPath(req.path)) return next();

      // First-run: nudge to /setup
      if (this.isFirstRun() && req.path === '/') {
        return res.redirect('/setup');
      }

      // Decide HTML vs API response
      const wantsJson = req.path.startsWith('/api/') || req.get('accept')?.includes('application/json');
      if (wantsJson) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      return res.redirect('/login');
    };
  }

  // Returns config snapshot for display in Settings UI (no secrets).
  publicConfig() {
    return {
      requirement: this.requirement,
      trustedNetworksRaw: this.trustedNetworks?.raw || DEFAULT_TRUSTED_CIDRS.join(','),
      trustedNetworksLocked: this.trustedNetworksLocked,
      trustedProxiesRaw: this.trustedProxies?.raw || '',
      trustedProxiesLocked: this.trustedProxiesLocked,
      hasCreds: this.hasCreds(),
      username: this.creds?.username || null,
    };
  }
}

module.exports = {
  AuthStore,
  FileSessionStore,
  REQUIRE_ALL,
  REQUIRE_EXT_LOCAL,
  SESSION_COOKIE_NAME,
  DEFAULT_TRUSTED_CIDRS,
  parseCidrList,
  ipMatchesBlocklist,
  hashPassword,
  verifyPassword,
  validatePassword,
  validateUsername,
  generateApiKey,
  isPublicPath,
};
