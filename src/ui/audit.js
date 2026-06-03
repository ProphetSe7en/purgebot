// Audit log - JSON-lines append-only file at /config/logs/audit-YYYY-MM-DD.log.
//
// Distinct from the main runtime log (purgebot-*.log) on purpose:
//   - One event per line, structured (jq-friendly, easy to feed to a SIEM).
//   - Different rotation knob (audit retention can outlive operational logs).
//   - Only carries security-relevant events: who did what, when, from where.
//     Not a noisy debug stream.
//
// Event categories shipped by Phase 1:
//   auth.*    login/logout/setup/csrf/ratelimit
//   config.*  config_write, webhook_test, manual_cleanup_trigger
//   discord.* delete batch, sort move, webhook send, channel recreate,
//             guild allowlist violation
//
// Schema per line:
//   { ts, event, actor: { user|api|anon|trusted|bot }, ip?, details }
//
// `actor` is normalised so a downstream parser can answer "what did <user> do"
// without needing to know which middleware classified the request. `details`
// is event-specific.

const fs = require('fs');
const path = require('path');

let _logDir = null;
let _fixOwnership = null;
let _onError = null;
let _lastFileOwned = '';

// Wire in bot.js's LOG_DIR + fixOwnership at startup so the audit file lands
// next to the runtime log + carries the same UID/GID.
function configure({ logDir, fixOwnership, onError }) {
  _logDir = logDir;
  _fixOwnership = typeof fixOwnership === 'function' ? fixOwnership : (() => {});
  _onError = typeof onError === 'function' ? onError : (() => {});
}

function _localDateParts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    iso: d.toISOString(),
  };
}

function _getAuditFile() {
  if (!_logDir) return null;
  return path.join(_logDir, `audit-${_localDateParts().date}.log`);
}

// Build a normalised `actor` field from a request's authContext (stamped by
// requireAuth middleware) or from an explicit override (Discord events).
function actorFromReq(req) {
  if (!req) return { kind: 'unknown' };
  const ctx = req.authContext;
  if (!ctx) return { kind: 'unknown' };
  if (ctx.sessionAuthed) return { kind: 'user', name: ctx.user?.username || 'unknown' };
  if (ctx.apiKeyAuthed) return { kind: 'api-key' };
  if (ctx.trustedBypass) return { kind: 'trusted-network' };
  return { kind: 'anonymous' };
}

// Append one event. Synchronous because the call sites are already running
// hot paths where we don't want lost-event windows on crash. Each event is
// best-effort: if the write fails, _onError is invoked but no exception
// propagates to the caller.
function record(event, fields = {}) {
  const file = _getAuditFile();
  if (!file) return;
  const entry = {
    ts: _localDateParts().iso,
    event,
    ...fields,
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    const isNewFile = file !== _lastFileOwned;
    if (isNewFile) {
      fs.mkdirSync(_logDir, { recursive: true });
      _fixOwnership(_logDir);
    }
    fs.appendFileSync(file, line, 'utf8');
    if (isNewFile) {
      // Force mode 600 on first append per day. Audit log carries
      // who-did-what data we don't want world-readable even on a host
      // where the umask leans permissive. chmod is idempotent + safe
      // on already-correct files.
      try { fs.chmodSync(file, 0o600); } catch (_) {}
      _fixOwnership(file);
      _lastFileOwned = file;
    }
  } catch (err) {
    _onError(`audit append failed: ${err.message}`);
  }
}

function rotate(maxDays) {
  if (!_logDir) return;
  try {
    const files = fs.readdirSync(_logDir)
      .filter(f => f.startsWith('audit-') && f.endsWith('.log'))
      .sort();
    while (files.length > maxDays) {
      const old = files.shift();
      fs.unlinkSync(path.join(_logDir, old));
    }
  } catch (err) {
    _onError(`audit rotate failed: ${err.message}`);
  }
}

module.exports = {
  configure,
  record,
  rotate,
  actorFromReq,
};
