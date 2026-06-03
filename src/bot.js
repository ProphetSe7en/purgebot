const { Client, GatewayIntentBits, ChannelType, PermissionsBitField } = require('discord.js');
const yaml = require('js-yaml');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const audit = require('./ui/audit'); // top-level require so any future hot-path can call audit.record safely; configure() runs in main below

// --- Log Event Emitter (for SSE streaming) ---
const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50); // Allow many SSE clients

// Set umask early - ensures correct permissions even via docker exec (which skips entrypoint)
process.umask(parseInt(process.env.UMASK || '002', 8));

const version = require('../package.json').version;

// --- Configuration ---

const CONFIG_PATH = process.env.CONFIG_PATH || '/config/config.yaml';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const HEARTBEAT_PATH = '/tmp/healthcheck';

if (!DISCORD_TOKEN) { console.error('DISCORD_TOKEN environment variable is required'); process.exit(1); }
if (!GUILD_ID) { console.error('GUILD_ID environment variable is required'); process.exit(1); }

let config = {};

function loadConfig(exitOnError = true) {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = yaml.load(raw) || {};
    parsed.globalDefault = parsed.globalDefault ?? 7;
    // (N3) Validate globalDefault
    if (typeof parsed.globalDefault !== 'number' || !Number.isInteger(parsed.globalDefault) || parsed.globalDefault < -1) {
      log('WARN', `Invalid globalDefault "${parsed.globalDefault}", using 7`);
      parsed.globalDefault = 7;
    }
    parsed.dryRun = parsed.dryRun ?? false;
    parsed.schedule = parsed.schedule || '0 2 * * *';
    // Timezone comes from TZ env var (set in Docker), not config
    parsed.timezone = process.env.TZ || 'UTC';
    parsed.discord = parsed.discord || {};
    // (N12) Validate discord config values
    parsed.discord.maxMessagesPerChannel = Math.max(1, Math.floor(parsed.discord.maxMessagesPerChannel ?? 500));
    parsed.discord.maxOldDeletesPerChannel = Math.max(0, Math.floor(parsed.discord.maxOldDeletesPerChannel ?? 50));
    parsed.discord.delayBetweenChannels = Math.max(0, Math.floor(parsed.discord.delayBetweenChannels ?? 500));
    parsed.discord.delayBetweenDeletes = Math.max(200, Math.floor(parsed.discord.delayBetweenDeletes ?? 400));
    parsed.discord.skipPinned = parsed.discord.skipPinned ?? true;
    // Opt-in UI for the rule editor. Defaults off so first-time users get
    // the simple cleanup view. Rules in config still apply at runtime
    // regardless; this toggle only controls whether the editor surfaces.
    parsed.discord.rulesUiEnabled = parsed.discord.rulesUiEnabled === true;
    parsed.logging = parsed.logging || {};
    parsed.logging.maxDays = Math.max(1, Math.floor(parsed.logging.maxDays ?? 30));
    parsed.webhooks = parsed.webhooks || {};
    parsed.webhooks.cleanupColor = parsed.webhooks.cleanupColor || '#238636';
    parsed.webhooks.infoColor = parsed.webhooks.infoColor || '#f39c12';
    parsed.webhooks.discovery = !!parsed.webhooks.discovery;
    parsed.gotify = parsed.gotify || {};
    parsed.gotify.enabled = !!parsed.gotify.enabled;
    parsed.gotify.url = (parsed.gotify.url || '').replace(/\/+$/, '');
    parsed.gotify.token = parsed.gotify.token || '';
    parsed.gotify.priorityWarning = parsed.gotify.priorityWarning !== false;
    parsed.gotify.warningValue = Math.max(0, Math.floor(parsed.gotify.warningValue ?? 5));
    parsed.gotify.priorityInfo = parsed.gotify.priorityInfo !== false;
    parsed.gotify.infoValue = Math.max(0, Math.floor(parsed.gotify.infoValue ?? 3));
    parsed.scheduleEnabled = parsed.scheduleEnabled !== false;
    parsed.display = parsed.display || {};
    parsed.display.timeFormat = parsed.display.timeFormat || '24h';
    parsed.sortEnabled = !!parsed.sortEnabled;
    parsed.sortAfterCleanup = !!parsed.sortAfterCleanup;
    parsed.sortIncludeVoice = !!parsed.sortIncludeVoice;
    parsed.sortInclude = parsed.sortInclude || {};
    parsed.sortPinned = parsed.sortPinned || {};
    parsed.webhookDiscoveryOnSchedule = !!parsed.webhookDiscoveryOnSchedule;
    parsed.categories = parsed.categories || {};

    // Prune stale sortInclude / sortPinned entries that reference categories
    // no longer in config (e.g. user switched Discord server or removed a
    // category via --sync). Keeps the Overview "Sort 37/29"-style mismatch
    // from drifting forever. sortSkip is handled the same way.
    const categoryNames = new Set(Object.keys(parsed.categories));
    for (const obj of [parsed.sortInclude, parsed.sortPinned, parsed.sortSkip]) {
      if (!obj || typeof obj !== 'object') continue;
      for (const name of Object.keys(obj)) {
        if (!categoryNames.has(name)) delete obj[name];
      }
    }

    // Warn about deprecated overrides: sections (#8)
    for (const [catName, cat] of Object.entries(parsed.categories)) {
      if (cat.overrides) {
        log('WARN', `Category "${catName}" uses deprecated 'overrides:' section - run --sync to migrate to inline format`);
      }
    }

    // Normalize legacy rule shapes to the unified `rules` array. Existing
    // configs written against the earlier dev iteration used separate
    // deleteRules / keepRules arrays at the category level; convert them.
    // Compiled regex is attached non-enumerably so the persisted YAML
    // stays clean.
    const normalizeLegacy = (target) => {
      if (!target) return;
      if (!Array.isArray(target.rules)) target.rules = [];
      if (Array.isArray(target.deleteRules)) {
        for (const r of target.deleteRules) target.rules.push({ ...r, action: 'delete' });
        delete target.deleteRules;
      }
      if (Array.isArray(target.keepRules)) {
        for (const r of target.keepRules) target.rules.push({ ...r, action: 'keep' });
        delete target.keepRules;
      }
    };
    normalizeLegacy(parsed);
    parsed.rules = validateAndCompileRulesList(parsed.rules, 'rules', ['categories', 'excludeCategories']);

    for (const [catName, cat] of Object.entries(parsed.categories)) {
      normalizeLegacy(cat);
      cat.rules = validateAndCompileRulesList(cat.rules, `categories.${catName}.rules`, ['channels', 'excludeChannels']);
    }

    // skipPinned stays as a top-level setting in Settings, not auto-migrated.
    // Rules can still target pinned messages (via the `pinned` condition
    // type) to override the default per channel or category. The scan loop
    // applies the setting as a fall-back AFTER rule evaluation, so a
    // delete-pinned rule for a specific scope wins over the global skip.

    // Clear+assign to keep exported reference stable
    Object.keys(config).forEach(k => delete config[k]);
    Object.assign(config, parsed);
    const enabledCount = Object.values(config.categories).filter(c => c.enabled === true).length;
    const totalCount = Object.keys(config.categories).length;
    log('INFO', `Config loaded: ${enabledCount}/${totalCount} categories enabled, globalDefault=${config.globalDefault}, dryRun=${config.dryRun}`);
  } catch (err) {
    // (N1, #10) On hot-reload failure, keep previous config instead of crashing
    if (!exitOnError) {
      log('ERROR', `Config reload failed, keeping previous config: ${err.message}`);
      return;
    }
    if (err.code === 'ENOENT') {
      console.error(`Config file not found: ${CONFIG_PATH}`);
      console.error('Mount a config volume with config.yaml - see config.yaml.sample for reference');
    } else {
      console.error(`Failed to load config: ${err.message}`);
    }
    process.exit(1);
  }
}

// --- Utility ---

const FILE_UID = parseInt(process.env.PUID || '99', 10);
const FILE_GID = parseInt(process.env.PGID || '100', 10);

function fixOwnership(filePath) {
  try { fs.chownSync(filePath, FILE_UID, FILE_GID); } catch {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeHeartbeat() {
  try { fs.writeFileSync(HEARTBEAT_PATH, Math.floor(Date.now() / 1000).toString(), 'utf8'); } catch {}
}

// --- Logging ---

const LOG_DIR = path.join(path.dirname(CONFIG_PATH), 'logs');

function localNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { date, time, datetime: `${date} ${time}` };
}

function getLogFile() {
  return path.join(LOG_DIR, `purgebot-${localNow().date}.log`);
}

// Track ownership: only mkdir/chown once per log file (resets on date rollover)
let lastLogFileOwned = '';

function log(level, msg) {
  const ts = localNow().datetime;
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  logEmitter.emit('log', { timestamp: ts, level, message: msg });
  try {
    const logFile = getLogFile();
    const isNewFile = logFile !== lastLogFileOwned;
    if (isNewFile) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fixOwnership(LOG_DIR);
    }
    fs.appendFileSync(logFile, line + '\n', 'utf8');
    if (isNewFile) {
      fixOwnership(logFile);
      lastLogFileOwned = logFile;
    }
  } catch {}
}

function rotateLogs(maxDays) {
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('purgebot-') && f.endsWith('.log')).sort();
    while (files.length > maxDays) {
      const old = files.shift();
      fs.unlinkSync(path.join(LOG_DIR, old));
    }
  } catch {}
}

// --- Channel List Helpers ---

// --- Rule Matching ---

// Accept both discord.js Collections (Map-like, has .values()) and plain
// arrays/objects. Used wherever we iterate msg.embeds / .attachments /
// embed.fields, since the shape differs between live and JSON-restored
// messages.
function collectFrom(collOrArray) {
  if (!collOrArray) return [];
  if (typeof collOrArray.values === 'function') return [...collOrArray.values()];
  if (Array.isArray(collOrArray)) return collOrArray;
  return [];
}

// Pull every URL out of a Discord message: the text body, embed.url,
// embed.image/thumbnail, and attachment URLs. Used by url-type rules.
// The regex is constructed per call so concurrent scans never share
// lastIndex state, which would corrupt the iteration if anything ever
// becomes async-interleaved. (Same trap that bit vpn-gateway v1.4.1.)
function extractUrls(msg) {
  const urlRe = /https?:\/\/[^\s<>"')\]]+/gi;
  const out = [];
  const content = msg.content || '';
  let m;
  while ((m = urlRe.exec(content)) !== null) out.push(m[0]);
  for (const e of collectFrom(msg.embeds)) {
    if (e?.url) out.push(e.url);
    if (e?.image?.url) out.push(e.image.url);
    if (e?.thumbnail?.url) out.push(e.thumbnail.url);
  }
  for (const a of collectFrom(msg.attachments)) {
    if (a?.url) out.push(a.url);
  }
  return out;
}

// Build a single haystack from msg.content + every text-bearing field of
// each embed. word and regex rules match against this combined string so
// bot/webhook-driven channels where the actual text lives in an embed
// description or field still work the way users expect.
// URLs are separate (extractUrls); attachment filenames are intentionally
// left out for now - keep that surface scoped to its own rule type later.
function extractMessageText(msg) {
  const parts = [];
  if (msg.content) parts.push(msg.content);
  for (const e of collectFrom(msg.embeds)) {
    if (!e) continue;
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(e.description);
    if (e.author?.name) parts.push(e.author.name);
    if (e.footer?.text) parts.push(e.footer.text);
    for (const f of collectFrom(e.fields)) {
      if (f?.name) parts.push(f.name);
      if (f?.value) parts.push(f.value);
    }
  }
  return parts.join('\n');
}

// JS regex is synchronous and can't be preempted, so a pathological pattern
// would block the bot for the duration. We cap input length (Discord caps
// content at 4000 anyway), measure elapsed time, and warn loudly if a
// pattern exceeds 100ms. Repeat offenders are visible in the log, and the
// UI surfaces them so the user can simplify or drop the pattern.
function safeRegexTest(regex, text) {
  if (!regex) return false;
  const sample = text.length > 8000 ? text.slice(0, 8000) : text;
  const start = Date.now();
  try {
    const result = regex.test(sample);
    const elapsed = Date.now() - start;
    if (elapsed > 100) {
      log('WARN', `Regex /${regex.source}/ took ${elapsed}ms on a ${sample.length}-char input. Consider simplifying the pattern; nested quantifiers like (.+)+ can run away on adversarial input.`);
    }
    return result;
  } catch (err) {
    log('WARN', `Regex test failed for /${regex.source}/: ${err.message}`);
    return false;
  }
}

// A single condition (one row in the rule modal). All conditions in a
// rule must match for the rule to fire (implicit AND inside a rule).
function matchCondition(msg, c) {
  switch (c.type) {
    case 'bot':
      return msg.author?.bot === true;
    case 'pinned':
      return msg.pinned === true;
    case 'user':
      return msg.author?.id === c.value;
    case 'word': {
      const text = extractMessageText(msg);
      // _compiled is a word-boundary regex when the value has word chars.
      // For pure-symbol values (e.g. "&&"), no boundary regex is built and
      // we fall back to substring match - those values have no useful
      // word boundary anyway.
      if (c._compiled) return safeRegexTest(c._compiled, text);
      return c.caseInsensitive
        ? text.toLowerCase().includes(c.value.toLowerCase())
        : text.includes(c.value);
    }
    case 'regex':
      return safeRegexTest(c._compiled, extractMessageText(msg));
    case 'url': {
      const urls = extractUrls(msg);
      // Empty value on a url condition = "the message has any URL".
      if (!c.value) return urls.length > 0;
      for (const url of urls) {
        if (safeRegexTest(c._compiled, url)) return true;
      }
      return false;
    }
    case 'attachment': {
      const atts = collectFrom(msg.attachments);
      if (atts.length === 0) return false;
      if (!c.value) return true;
      for (const a of atts) {
        if (a?.name && safeRegexTest(c._compiled, a.name)) return true;
      }
      return false;
    }
    case 'image': {
      // Image attachment (detected by content-type or extension) or an
      // embed with an image/thumbnail URL counts.
      const imageExt = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i;
      for (const a of collectFrom(msg.attachments)) {
        if (typeof a?.contentType === 'string' && a.contentType.startsWith('image/')) return true;
        if (typeof a?.name === 'string' && imageExt.test(a.name)) return true;
      }
      for (const e of collectFrom(msg.embeds)) {
        if (e?.image?.url || e?.thumbnail?.url) return true;
      }
      return false;
    }
    case 'mention': {
      const m = msg.mentions;
      if (!m) return false;
      if (!c.value) {
        if (m.everyone) return true;
        const userCount = m.users?.size ?? (Array.isArray(m.users) ? m.users.length : 0);
        const roleCount = m.roles?.size ?? (Array.isArray(m.roles) ? m.roles.length : 0);
        return userCount > 0 || roleCount > 0;
      }
      const v = c.value.toLowerCase();
      if (v === 'everyone' || v === '@everyone' || v === 'here' || v === '@here') {
        return m.everyone === true;
      }
      for (const u of collectFrom(m.users)) if (u?.id === c.value) return true;
      for (const r of collectFrom(m.roles)) if (r?.id === c.value) return true;
      return false;
    }
    case 'reply': {
      return !!(msg.reference && (msg.reference.messageId || msg.reference.messageID));
    }
  }
  return false;
}

// A rule's conditions are joined by per-condition operators. The first
// condition starts the chain; subsequent conditions either extend the
// current AND group (`join: 'and'`, default) or start a new OR group
// (`join: 'or'`). The rule fires when ANY group's conditions all match.
// This gives standard AND > OR precedence: `A AND B OR C` is `(A AND B) OR C`.
// Multiple rules at the same level still combine as OR - adding two rules
// is equivalent to one rule with the conditions joined by OR.
// Returns null on no match, or { conditions } where conditions is the array
// of condition objects from the FIRST winning AND-group. The caller can use
// these for per-message attribution ("matched on word \"test\"") without
// having to re-run matchCondition.
function matchRule(msg, rule) {
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) return null;
  const groups = [];
  let current = [];
  for (const c of rule.conditions) {
    if (current.length === 0) {
      current.push(c);
    } else if (c.join === 'or') {
      groups.push(current);
      current = [c];
    } else {
      current.push(c);
    }
  }
  if (current.length > 0) groups.push(current);
  for (const group of groups) {
    if (group.every(c => matchCondition(msg, c))) {
      return { conditions: group };
    }
  }
  return null;
}

// Three specificity tiers, most specific first. The first tier with any
// matching rule decides the outcome for that message. Within a tier,
// keep beats delete on conflict.
const RULE_TIERS = ['channel-explicit', 'category-default', 'global'];

// Evaluate a leveled rule list against a message. `leveledRules` is an
// array of { level, rule } items. Returns:
//   decision : 'keep' | 'delete' | 'none'
//   tier     : which level decided (null when decision === 'none')
//   conflict : true when keep and delete both matched within the winning tier
function evaluateMessageRules(msg, leveledRules) {
  for (const tier of RULE_TIERS) {
    const keepMatches = [];
    const deleteMatches = [];
    for (const { level, rule } of leveledRules) {
      if (level !== tier) continue;
      const m = matchRule(msg, rule);
      if (!m) continue;
      const entry = { rule, conditions: m.conditions };
      if (rule.action === 'keep') keepMatches.push(entry);
      else if (rule.action === 'delete') deleteMatches.push(entry);
    }
    if (keepMatches.length === 0 && deleteMatches.length === 0) continue;
    if (keepMatches.length > 0) {
      return {
        decision: 'keep',
        tier,
        keepMatches,
        deleteMatches,
        conflict: deleteMatches.length > 0,
      };
    }
    return {
      decision: 'delete',
      tier,
      keepMatches: [],
      deleteMatches,
      conflict: false,
    };
  }
  return { decision: 'none', tier: null, keepMatches: [], deleteMatches: [], conflict: false };
}

// Short human-readable label for a single condition. Used in conflict
// warnings, per-message attribution chips, and the dry-run dashboard.
function describeCondition(c) {
  if (!c) return '(unknown condition)';
  switch (c.type) {
    case 'bot':        return 'any bot';
    case 'pinned':     return 'pinned';
    case 'user':       return `user ${c.value}`;
    case 'url':        return c.value ? `URL matching /${c.value}/` : 'any URL';
    case 'word':       return `word "${c.value}"`;
    case 'regex':      return `text matching /${c.value}/`;
    case 'attachment': return c.value ? `attachment named /${c.value}/` : 'any attachment';
    case 'image':      return 'an image';
    case 'mention':    return c.value ? `mention of ${c.value}` : 'any mention';
    case 'reply':      return 'a reply';
    default:           return c.type;
  }
}

// Human-readable summary of a rule, used in conflict warnings and the
// dry-run dashboard. Prefers the user's free-text note when present.
// Renders the same AND-then-OR grouping that matchRule evaluates, so the
// printed expression reflects the actual evaluation.
function describeRule(rule) {
  if (!rule) return '(unknown rule)';
  if (rule.note) return `"${rule.note}"`;
  const describeC = describeCondition;
  const groups = [];
  let current = [];
  for (const c of (rule.conditions || [])) {
    if (current.length === 0) current.push(c);
    else if (c.join === 'or') { groups.push(current); current = [c]; }
    else current.push(c);
  }
  if (current.length > 0) groups.push(current);
  const describeGroup = g => g.length === 1 ? describeC(g[0]) : `(${g.map(describeC).join(' AND ')})`;
  return groups.length === 1 ? describeGroup(groups[0]) : groups.map(describeGroup).join(' OR ');
}

// _channels entries support two shapes, the second is the legacy retention
// shortcut still parsed for backward compatibility:
//   "general"           → no per-channel override
//   {"general": 3}      → retention override (days). -1 = never delete.
// Per-channel rules live ON the category-level rule via its `channels` /
// `excludeChannels` filters in the new model; there's no per-channel rule
// block on _channels entries anymore.
function getChannelOverride(cat, channelName) {
  if (!cat._channels || !Array.isArray(cat._channels)) return undefined;
  for (const entry of cat._channels) {
    if (typeof entry === 'object' && entry !== null && entry[channelName] !== undefined) {
      const value = entry[channelName];
      if (typeof value === 'number') return value;
    }
  }
  return undefined;
}

// Build the leveled rule list to evaluate for a single (category, channel)
// pair. Each entry is { level, rule } where level is one of:
//   'channel-explicit'  → category rule that names this channel in `channels`
//   'category-default'  → category rule applying to this channel by default
//                         (no `channels` filter or excluded-channels allowed
//                         the channel through)
//   'global'            → global rule applying to this category
// The evaluator picks the most-specific tier with any match.
function getEffectiveRules(globalRules, cat, categoryName, channelName) {
  const out = [];

  for (const rule of (globalRules || [])) {
    if (!ruleScopeIncludesCategory(rule, categoryName)) continue;
    out.push({ level: 'global', rule });
  }

  for (const rule of (cat.rules || [])) {
    const hasAllowList = Array.isArray(rule.channels) && rule.channels.length > 0;
    if (hasAllowList) {
      if (!rule.channels.includes(channelName)) continue;
      out.push({ level: 'channel-explicit', rule });
    } else {
      if (Array.isArray(rule.excludeChannels) && rule.excludeChannels.includes(channelName)) continue;
      out.push({ level: 'category-default', rule });
    }
  }

  return out;
}

function ruleScopeIncludesCategory(rule, categoryName) {
  if (Array.isArray(rule.categories) && rule.categories.length > 0) {
    if (!rule.categories.includes(categoryName)) return false;
  }
  if (Array.isArray(rule.excludeCategories) && rule.excludeCategories.includes(categoryName)) {
    return false;
  }
  return true;
}

// --- Retention Resolution ---

function isEnabled(categoryName) {
  const cat = config.categories[categoryName];
  if (!cat) return false;
  return cat.enabled === true;
}

// (#2, #19) Validate retention value - must be integer, >= -1
function validateRetention(value, context) {
  if (typeof value !== 'number' || !Number.isInteger(value) || (value < -1)) {
    log('WARN', `Invalid retention value "${value}" for ${context}, using globalDefault (${config.globalDefault})`);
    return config.globalDefault;
  }
  return value;
}

// Allowed condition types. `bot`, `pinned`, `image`, and `reply` are value-
// less and always require no value field. `url`, `attachment`, and
// `mention` accept an optional value (empty = "any of this kind").
// The remaining types need a non-empty `value` string.
const CONDITION_TYPES = ['user', 'word', 'url', 'regex', 'bot', 'pinned', 'attachment', 'image', 'mention', 'reply'];
const VALUELESS_CONDITION_TYPES = new Set(['bot', 'pinned', 'image', 'reply']);
const VALUE_OPTIONAL_CONDITION_TYPES = new Set(['url', 'attachment', 'mention']);
const REGEX_COMPILABLE_TYPES = new Set(['url', 'regex', 'attachment']);

// Validate + compile a single condition. Returns the normalized condition
// or null when the input is unusable.
function validateAndCompileCondition(raw, context) {
  if (typeof raw !== 'object' || raw === null) {
    log('WARN', `Condition at ${context} is not an object, dropping`);
    return null;
  }
  const type = raw.type;
  if (!CONDITION_TYPES.includes(type)) {
    log('WARN', `Condition at ${context} has unknown type "${type}", dropping`);
    return null;
  }
  const requiresValue = !VALUELESS_CONDITION_TYPES.has(type) && !VALUE_OPTIONAL_CONDITION_TYPES.has(type);
  const hasValue = typeof raw.value === 'string' && raw.value.length > 0;
  if (requiresValue && !hasValue) {
    log('WARN', `Condition at ${context} (type=${type}) has empty or missing value, dropping`);
    return null;
  }
  let caseInsensitive = true;
  if (raw.caseInsensitive !== undefined) {
    if (typeof raw.caseInsensitive !== 'boolean') {
      log('WARN', `Condition at ${context} has non-boolean caseInsensitive "${raw.caseInsensitive}", treating as true`);
    } else {
      caseInsensitive = raw.caseInsensitive;
    }
  }
  const normalized = {
    type,
    value: VALUELESS_CONDITION_TYPES.has(type) ? '' : (hasValue ? raw.value : ''),
    caseInsensitive,
  };
  // join controls how this condition combines with the previous one in the
  // same rule: 'and' (default) extends the current AND group, 'or' starts
  // a new group. The first condition's join is ignored at runtime.
  if (raw.join === 'or') normalized.join = 'or';
  if (REGEX_COMPILABLE_TYPES.has(type) && hasValue) {
    try {
      const compiled = new RegExp(raw.value, caseInsensitive ? 'i' : '');
      Object.defineProperty(normalized, '_compiled', { value: compiled, enumerable: false });
    } catch (err) {
      log('WARN', `Condition at ${context} (type=${type}) has invalid regex "${raw.value}": ${err.message}`);
      return null;
    }
  }
  // Word matching uses a word-boundary regex so "test" matches the word
  // "test" but NOT "testaments", "latest", or "Greatest". Users typing
  // a word expect word semantics; substring matching is what the `regex`
  // condition type is for.
  //
  // \b in JavaScript regex is ASCII-only: it treats only [A-Za-z0-9_] as
  // word chars, even with the /u flag. That breaks two value shapes:
  //   1. Non-ASCII letters at the edge (Norwegian "Tøffel", "café") - the
  //      boundary check looks for an ASCII word/non-word transition and
  //      misses transitions involving ø/é/å.
  //   2. Values with non-word edges ("WORD!", ",foo") - the trailing \b
  //      requires a word/non-word transition AT the edge, but if the value's
  //      own edge is already non-word, there's no transition to find.
  //
  // For those shapes, fall back to substring match (no _compiled property,
  // matchCondition sees the missing _compiled and uses .includes()). For
  // ASCII-only values with ASCII-word edges, build the \b...\b regex.
  if (type === 'word' && hasValue) {
    const hasWordChar = /\w/.test(raw.value);
    const asciiEdges = /^[A-Za-z0-9_]/.test(raw.value) && /[A-Za-z0-9_]$/.test(raw.value);
    const allAscii = /^[\x00-\x7F]*$/.test(raw.value);
    if (hasWordChar && asciiEdges && allAscii) {
      try {
        const escaped = raw.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const compiled = new RegExp(`\\b${escaped}\\b`, caseInsensitive ? 'i' : '');
        Object.defineProperty(normalized, '_compiled', { value: compiled, enumerable: false });
      } catch (err) {
        log('WARN', `Word condition at ${context} could not compile to word-boundary regex: ${err.message}`);
      }
    }
  }
  return normalized;
}

// Validate + compile a list of unified rules. Each rule has:
//   action     : 'keep' | 'delete'                            (required)
//   conditions : array of conditions                          (required, AND)
//   note       : free text label                              (optional)
// Scope filters depend on where the rule lives:
//   - Global rules use `categories` / `excludeCategories`
//   - Category rules use `channels`   / `excludeChannels`
// Filters are validated lazily - we keep arrays as-is and the runtime
// scope check uses them. Returns a fresh array; invalid rules are dropped.
function validateAndCompileRulesList(rules, context, scopeFilterKeys = []) {
  if (rules === undefined || rules === null) return [];
  if (!Array.isArray(rules)) {
    log('WARN', `Rules at ${context} is not a list, ignoring`);
    return [];
  }
  const valid = [];
  for (let i = 0; i < rules.length; i++) {
    const raw = rules[i];
    if (typeof raw !== 'object' || raw === null) {
      log('WARN', `Rule #${i + 1} at ${context} is not an object, dropping`);
      continue;
    }
    const action = raw.action;
    if (action !== 'keep' && action !== 'delete') {
      log('WARN', `Rule #${i + 1} at ${context} has invalid action "${action}" (expected "keep" or "delete"), dropping`);
      continue;
    }
    const conditions = [];
    const rawConditions = Array.isArray(raw.conditions) ? raw.conditions
      : (raw.type ? [raw] : []); // legacy single-condition shape: {type, value, ...}
    if (rawConditions.length === 0) {
      log('WARN', `Rule #${i + 1} at ${context} has no conditions, dropping`);
      continue;
    }
    for (let j = 0; j < rawConditions.length; j++) {
      const c = validateAndCompileCondition(rawConditions[j], `${context} rule#${i + 1} cond#${j + 1}`);
      if (c) conditions.push(c);
    }
    if (conditions.length === 0) {
      log('WARN', `Rule #${i + 1} at ${context} had only invalid conditions, dropping`);
      continue;
    }
    const normalized = { action, conditions };
    if (raw.note) normalized.note = String(raw.note);
    for (const key of scopeFilterKeys) {
      if (Array.isArray(raw[key])) {
        normalized[key] = raw[key].slice().filter(v => typeof v === 'string' && v.length > 0);
        if (normalized[key].length === 0) delete normalized[key];
      }
    }
    valid.push(normalized);
  }
  return valid;
}

function getRetention(categoryName, channelName) {
  const cat = config.categories[categoryName];
  if (!cat) return null;

  // Step 1: Check inline override in _channels list
  const override = getChannelOverride(cat, channelName);
  if (override !== undefined) return validateRetention(override, `${categoryName}/#${channelName}`);

  // Step 2: Check category default
  if (cat.default !== undefined) return validateRetention(cat.default, `${categoryName}/default`);

  // Step 3: Global default
  return config.globalDefault;
}

function getRetentionSource(categoryName, channelName) {
  const cat = config.categories[categoryName];
  if (!cat) return 'global';
  if (getChannelOverride(cat, channelName) !== undefined) return 'override';
  if (cat.default !== undefined) return 'category';
  return 'global';
}

// --- Config File Header ---

const CONFIG_HEADER = `# PurgeBot - Configuration
#
# Retention hierarchy (first match wins):
#   1. Inline override on channel  - per-channel retention
#   2. default                     - category-wide default
#   3. globalDefault               - fallback for categories without a default
#
# Retention values:
#   -1   = Never delete (keep all messages forever)
#    0   = Delete all messages (bulk <14d + individual >14d, capped per run)
#    N   = Keep messages newer than N days, delete older ones
#
# Discord limits bulk delete to messages <14 days old. Older messages are
# deleted individually, capped at maxOldDeletesPerChannel per channel per run.
# Pinned messages are always skipped when skipPinned is true (default).
#
# Categories must have "enabled: true" to be cleaned.
# _channels is auto-populated by --sync. Add ": <days>" to override a channel.
# Config is re-read before each cleanup run - no restart needed after editing.
# Schedule changes via the Web UI take effect immediately.
# Timezone is set via the TZ environment variable in Docker.
#
# deleteOld: true  - delete all messages older than retention (default)
# deleteOld: false - only bulk-delete messages up to 14 days old (faster)
#
# Example:
#   my-category:
#     enabled: true
#     default: 7                    # all channels: 7 days
#     deleteOld: false              # skip slow individual deletes (>14 days)
#     _channels:
#       - general                   # uses category default (7 days)
#       - error-channel: 14         # override: 14 days
#       - noisy-channel: 3          # override: 3 days
#       - important-log: -1         # override: never delete
#
# Commands:
#   docker exec purgebot node src/bot.js --sync   # discover channels
#   docker exec purgebot node src/bot.js --now    # run cleanup now

`;

// Strip internal keys before writing config to disk or sending via API
function configForDisk() {
  const { timezone, ...rest } = config;
  return rest;
}

function formatRetention(days) {
  if (days === -1) return 'never delete';
  if (days === 0) return 'delete all';
  return `${days} days`;
}

// Returns channel names listed in _channels for a category
function getConfiguredChannels(categoryName) {
  const cat = config.categories[categoryName];
  if (!cat || !Array.isArray(cat._channels)) return new Set();
  const names = new Set();
  for (const entry of cat._channels) {
    if (typeof entry === 'string') names.add(entry);
    else if (typeof entry === 'object' && entry !== null) names.add(Object.keys(entry)[0]);
  }
  return names;
}

// --- Discord Client ---

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// Tracks how long Discord makes us wait on rate limits. discord.js obeys
// every 429 by sleeping for the time Discord dictates, so this is wall-time
// we have no control over. The cleanup loop snapshots totalMs around each
// channel to show how much of a channel's run time was Discord throttling
// (deleting messages older than 14 days has a strict, separate limit).
const rateLimitTracker = { totalMs: 0, hits: 0 };
client.rest.on('rateLimited', (info) => {
  const waitMs = info.timeToReset ?? info.retryAfter ?? 0;
  rateLimitTracker.totalMs += waitMs;
  rateLimitTracker.hits++;
});

// --- Credential masking ---
// The UI never receives plaintext credentials. On GET /api/config we replace
// each saved credential with this sentinel; on PUT/PATCH/test-* the sentinel
// resolves back to the stored value. A non-sentinel value (including the
// empty string) is treated as a deliberate change by the user.
//
// This is defensive even before auth lands: the LAN bypass still exists, but
// at least no passing observer of an /api/config response gets a working
// webhook token from a casual inspection.

const CRED_MASK = '__credential_unchanged__';

function maskCredential(value) {
  return (typeof value === 'string' && value.length > 0) ? CRED_MASK : '';
}

function resolveMaskedCredential(submitted, current) {
  if (submitted === CRED_MASK) return typeof current === 'string' ? current : '';
  return typeof submitted === 'string' ? submitted : '';
}

function maskedConfigSnapshot(cfg) {
  // Deep-clone so we never mutate live config when shaping the response.
  const snapshot = JSON.parse(JSON.stringify(cfg));
  if (snapshot.webhooks && typeof snapshot.webhooks === 'object') {
    if (typeof snapshot.webhooks.cleanup === 'string') {
      snapshot.webhooks.cleanup = maskCredential(snapshot.webhooks.cleanup);
    }
    if (typeof snapshot.webhooks.info === 'string') {
      snapshot.webhooks.info = maskCredential(snapshot.webhooks.info);
    }
  }
  if (snapshot.gotify && typeof snapshot.gotify === 'object' && typeof snapshot.gotify.token === 'string') {
    snapshot.gotify.token = maskCredential(snapshot.gotify.token);
  }
  return snapshot;
}

// --- Outbound URL validation ---
// Validates the URL host before every outbound fetch. Defense against
// config tampering: if someone edits the webhook URL to point at an
// arbitrary host, the cleanup summary would otherwise be leaked there.

const DISCORD_WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com']);

function isAllowedDiscordWebhookUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (!DISCORD_WEBHOOK_HOSTS.has(u.hostname)) return false;
    return u.pathname.startsWith('/api/webhooks/');
  } catch (_) {
    return false;
  }
}

function isAllowedGotifyUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// --- Webhook Notification ---

async function sendWebhook(embeds) {
  const webhookUrl = config.webhooks.cleanup;
  if (!webhookUrl) return;
  if (!isAllowedDiscordWebhookUrl(webhookUrl)) {
    log('WARN', 'Cleanup webhook URL is not a valid Discord webhook - refusing to send');
    return;
  }

  // Discord allows max 10 embeds per message
  for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10);
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: batch }),
      });
      // (#20) Log webhook error response body for debugging
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log('WARN', `Webhook response: ${res.status} - ${body}`);
      }
      if (i + 10 < embeds.length) await sleep(1000);
    } catch (err) {
      log('ERROR', `Webhook failed: ${err.message}`);
    }
  }
}

async function sendSummaryNotification(runStats) {
  if (runStats.dryRun) return;
  if (runStats.totalPurged === 0 && runStats.totalErrors === 0) return;

  const catCount = Object.keys(runStats.categories || {}).length;
  const trigger = (runStats.trigger || 'schedule').charAt(0).toUpperCase() + (runStats.trigger || 'schedule').slice(1);
  const titleSuffix = runStats.cancelled ? 'Stopped' : 'Complete';
  // Sum across categories so the embed reports rule vs retention without the
  // reader having to read every category embed.
  let totalByRule = 0;
  let totalByRetention = 0;
  for (const c of Object.values(runStats.categories || {})) {
    for (const ch of (c.channels || [])) {
      totalByRule += ch.rollup?.byRule ?? ch.deletedByRule ?? 0;
      totalByRetention += ch.rollup?.byRetention ?? Math.max(0, (ch.purged || 0) - (ch.deletedByRule || 0));
    }
  }
  let description;
  if (runStats.ruleOnly && runStats.ruleDescription) {
    // Rule-only summary highlights what fired; the reader doesn't have to
    // cross-reference the rule list.
    const where = runStats.ruleOnly.scope === 'category'
      ? `category **${runStats.ruleOnly.categoryName}**`
      : '**global rule**';
    description = `Ran ${where} only - ${runStats.ruleDescription}\nDeleted **${runStats.totalPurged}** messages from **${runStats.totalProcessed}** channels in **${formatDuration(runStats.duration)}**`;
  } else {
    description = `Deleted **${runStats.totalPurged}** messages from **${runStats.totalProcessed}** channels (${catCount} categories) in **${formatDuration(runStats.duration)}**`;
    if (totalByRule > 0 || totalByRetention > 0) {
      const parts = [];
      if (totalByRule > 0) parts.push(`${totalByRule} by rule`);
      if (totalByRetention > 0) parts.push(`${totalByRetention} by retention`);
      description += `\n${parts.join(' · ')}`;
    }
  }
  if (runStats.totalScanned) {
    description += `\nScanned ${runStats.totalScanned.toLocaleString()} message${runStats.totalScanned !== 1 ? 's' : ''}`;
  }
  if (runStats.totalErrors > 0) {
    description += `\n⚠ ${runStats.totalErrors} error${runStats.totalErrors !== 1 ? 's' : ''}`;
  }
  if (runStats.cancelled) {
    description += `\n⚠ Cancelled (partial run)`;
  }

  // Channels still carrying messages older than 14 days, surfaced so the
  // reader knows why a run took a while and which channels need more runs.
  const backloggedChannels = [];
  for (const [, s] of Object.entries(runStats.categories || {})) {
    for (const ch of (s.channels || [])) {
      if (ch.oldRemaining > 0) backloggedChannels.push(ch.name);
    }
  }
  if (backloggedChannels.length > 0) {
    const shown = backloggedChannels.slice(0, 5).map(n => '#' + n).join(', ');
    const more = backloggedChannels.length > 5 ? ` and ${backloggedChannels.length - 5} more` : '';
    description += `\n⏳ Still clearing older messages in ${shown}${more}. These finish over the next few runs.`;
  }

  // Discord notification
  const webhookUrl = config.webhooks.info;
  if (webhookUrl && !isAllowedDiscordWebhookUrl(webhookUrl)) {
    log('WARN', 'Summary info webhook URL is not a valid Discord webhook - refusing to send');
  } else if (webhookUrl) {
    const infoColor = parseInt((config.webhooks?.infoColor || '#f39c12').replace('#', ''), 16) || 0xf39c12;
    const embed = {
      title: `Cleanup ${titleSuffix} · ${trigger} Run`,
      description,
      color: runStats.totalErrors > 0 ? 0xe74c3c : infoColor,
      footer: { text: `PurgeBot v${version} by ProphetSe7en` },
      timestamp: new Date().toISOString(),
    };

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log('WARN', `Summary webhook response: ${res.status} - ${body}`);
      }
    } catch (err) {
      log('ERROR', `Summary webhook failed: ${err.message}`);
    }
  }

  // Gotify notification - combined summary with per-category breakdown
  let gotifyMsg = description;
  const cats = runStats.categories || {};
  // Surface a category if anything happened: purged, errors, kept by rule,
  // or rule conflicts. Keeps the breakdown informative when rules fire on
  // an otherwise quiet category.
  const activeCats = Object.entries(cats).filter(([, s]) =>
    s.purged > 0 || s.errors > 0 || s.keptByRule > 0 || s.ruleConflicts > 0);
  if (activeCats.length > 0) {
    gotifyMsg += '\n';
    for (const [catName, stats] of activeCats) {
      let line = `- **${catName}:** ${stats.purged} purged in ${formatDuration(stats.durationMs)}`;
      if (stats.deletedByRule > 0) line += ` (${stats.deletedByRule} by rule)`;
      if (stats.keptByRule > 0) line += `, ${stats.keptByRule} protected by rule`;
      if (stats.errors > 0) line += `, ${stats.errors} error${stats.errors !== 1 ? 's' : ''}`;
      if (stats.ruleConflicts > 0) line += `, ${stats.ruleConflicts} rule conflict${stats.ruleConflicts !== 1 ? 's' : ''}`;
      gotifyMsg += '\n' + line;
    }
  }
  const level = runStats.totalErrors > 0 ? 'warning' : 'info';
  await sendGotify(`PurgeBot: Cleanup ${titleSuffix}`, gotifyMsg, level);
}

function formatDuration(ms) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// Turn a raw Discord/API error into a plain sentence a non-technical
// PurgeBot user can act on. Raw messages still go to the log; this is
// what we show in the dashboard and notifications.
function humanizeError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('missing permissions') || m.includes('50013') ||
      m.includes('missing access') || m.includes('50001')) {
    return "PurgeBot is missing permission to manage messages in this channel.";
  }
  if (m.includes('rate limit') || m.includes('429')) {
    return "Discord asked PurgeBot to slow down here; the rest will be picked up on the next run.";
  }
  if (m.includes('unknown channel') || m.includes('10003')) {
    return "This channel no longer exists on the server.";
  }
  return "PurgeBot couldn't finish this channel. Check that it can see and manage messages here, then try again.";
}

// (#14) Truncate embed description to stay within Discord's 4096 char limit
function buildCategoryEmbed(catName, channelResults, hasErrors, isDryRun, opts = {}) {
  const { ruleOnly = false, ruleDescription = null, ruleAction = null } = opts;
  const prefix = isDryRun ? 'Dry Run - ' : '';
  const kind = ruleOnly ? 'Rule Run' : 'Message Cleanup';
  const lines = [];

  // Rule-only header: first line spells out exactly what fired so the
  // reader doesn't have to guess from the per-channel sums.
  if (ruleOnly && ruleDescription) {
    const verb = ruleAction === 'keep' ? '🛡 Keep' : '🗑 Delete';
    lines.push(`**${verb} rule:** ${ruleDescription}`);
    lines.push('');
  }

  for (const ch of channelResults) {
    if (ch.error) {
      lines.push(`#${ch.name} - ❌ ${ch.error}`);
    } else if (ch.purged > 0) {
      const source = ch.retentionSource === 'override' ? ' (override)' : '';
      const retentionLabel = ruleOnly
        ? 'rule-only'
        : (ch.retention === -1 ? 'never' : `${ch.retention}d`);
      // Inline rule-vs-retention split. Surfaces directly in Discord so the
      // reader doesn't have to open the Web UI to interpret the number.
      const byRule = ch.rollup?.byRule ?? ch.deletedByRule ?? 0;
      const byRetention = ch.rollup?.byRetention ?? Math.max(0, (ch.purged || 0) - byRule);
      const splitParts = [];
      if (byRule > 0) splitParts.push(`${byRule} by rule`);
      if (byRetention > 0) splitParts.push(`${byRetention} by retention`);
      const split = splitParts.length ? ` (${splitParts.join(', ')})` : '';
      // Scan context so an empty channel + huge scan doesn't look the same
      // as a small channel that's fully covered.
      const scannedNote = ch.scannedCount
        ? ` · scanned ${ch.scannedCount.toLocaleString()}${ch.scanComplete ? ' (whole channel)' : ''}`
        : '';
      lines.push(`#${ch.name} - ${retentionLabel}${source} - **${ch.purged} purged**${split}${scannedNote}`);
    } else if (ch.scannedCount > 0 && (ruleOnly || ch.deletedByRule === 0)) {
      // Zero-purge channels in a rule-only run still deserve a line so the
      // reader can see "we looked, nothing matched" instead of silence.
      lines.push(`#${ch.name} - scanned ${ch.scannedCount.toLocaleString()}${ch.scanComplete ? ' (whole channel)' : ''} - nothing matched`);
    }
    if (ch.keptByRule > 0) {
      lines.push(`#${ch.name} - 🛡 ${ch.keptByRule} protected by rule`);
    }
    for (const w of (ch.warnings || [])) {
      lines.push(`#${ch.name} - ⚠ ${w}`);
    }
  }

  const catDurationMs = channelResults.reduce((sum, ch) => sum + (ch.durationMs || 0), 0);
  const totalPurged = channelResults.reduce((sum, ch) => sum + (ch.purged || 0), 0);
  const totalScanned = channelResults.reduce((sum, ch) => sum + (ch.scannedCount || 0), 0);
  const successColor = parseInt((config.webhooks?.cleanupColor || '#238636').replace('#', ''), 16) || 0x238636;
  let color = isDryRun ? 0x3498db : successColor;
  if (hasErrors) color = 0xe74c3c;
  if (totalPurged === 0 && !hasErrors) color = 0x95a5a6;

  let description = lines.join('\n');
  if (description.length > 4000) {
    description = description.substring(0, 3990) + '\n... (truncated)';
  }

  return {
    title: `${prefix}${kind} - ${catName}`,
    description,
    color,
    footer: { text: `${channelResults.length} channels • ${totalScanned.toLocaleString()} scanned • ${totalPurged} ${isDryRun ? 'would be purged' : 'purged'} • ${formatDuration(catDurationMs)} · PurgeBot v${version} by ProphetSe7en` },
    timestamp: new Date().toISOString(),
  };
}

// --- Auto-Discovery ---

// Discovers new categories/channels and removes deleted ones from config.
// New categories are always disabled. New channels inherit category default.
async function autoDiscoverChannels(guild) {
  const discordCategories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory);
  const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText && c.parentId);

  const discoveredMap = new Map();
  for (const [, channel] of textChannels) {
    const category = discordCategories.get(channel.parentId);
    if (!category) continue;
    if (!discoveredMap.has(category.name)) discoveredMap.set(category.name, []);
    discoveredMap.get(category.name).push(channel.name);
  }

  // Don't notify on first auto-discovery run - only on subsequent changes
  const isFirstDiscovery = !config._discoveryComplete;
  let changes = 0;
  const discoveries = [];

  // --- Add new categories and channels ---
  for (const [catName, channels] of discoveredMap) {
    const sortedChannels = [...channels].sort();

    if (!config.categories[catName]) {
      config.categories[catName] = { enabled: false, default: config.globalDefault, _channels: sortedChannels };
      changes++;
      log('INFO', `Auto-discovered category "${catName}" (DISABLED) - ${channels.length} channels`);
      discoveries.push({ type: 'category', name: catName, channels: sortedChannels });
      continue;
    }

    const cat = config.categories[catName];
    const existingNames = getConfiguredChannels(catName);

    for (const chanName of sortedChannels) {
      if (!existingNames.has(chanName)) {
        if (!Array.isArray(cat._channels)) cat._channels = [];
        cat._channels.push(chanName);
        cat._channels.sort((a, b) => {
          const nameA = typeof a === 'string' ? a : Object.keys(a)[0];
          const nameB = typeof b === 'string' ? b : Object.keys(b)[0];
          return nameA.localeCompare(nameB);
        });
        changes++;
        const effectiveRetention = cat.default ?? config.globalDefault;
        const source = cat.default !== undefined ? 'category' : 'global';
        log('INFO', `Auto-discovered #${chanName} in "${catName}" (${formatRetention(effectiveRetention)} - ${source} default)`);
        discoveries.push({ type: 'channel', name: chanName, category: catName, retention: effectiveRetention, source, enabled: cat.enabled });
      }
    }
  }

  // --- Remove deleted channels and categories ---
  for (const catName of Object.keys(config.categories)) {
    const discordChannels = discoveredMap.get(catName);

    if (!discordChannels) {
      // Entire category gone from Discord
      const cat = config.categories[catName];
      const channelCount = Array.isArray(cat._channels) ? cat._channels.length : 0;
      log('INFO', `Category "${catName}" removed from Discord (${channelCount} channels)`);
      discoveries.push({ type: 'category-removed', name: catName, channelCount });
      delete config.categories[catName];
      changes++;
      continue;
    }

    // Check for removed channels within existing category
    const cat = config.categories[catName];
    if (!Array.isArray(cat._channels)) continue;
    const discordSet = new Set(discordChannels);
    const before = cat._channels.length;
    const removed = [];
    cat._channels = cat._channels.filter(entry => {
      const name = typeof entry === 'string' ? entry : Object.keys(entry)[0];
      if (discordSet.has(name)) return true;
      removed.push(name);
      return false;
    });
    if (removed.length > 0) {
      changes += removed.length;
      for (const name of removed) {
        log('INFO', `Channel #${name} removed from "${catName}" (deleted from Discord)`);
        discoveries.push({ type: 'channel-removed', name, category: catName });
      }
    }
  }

  if (changes > 0 || isFirstDiscovery) {
    config._discoveryComplete = true;
    const yamlStr = yaml.dump(configForDisk(), { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false });
    const tmpPath = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, CONFIG_HEADER + yamlStr, 'utf8');
    fs.renameSync(tmpPath, CONFIG_PATH);
    fixOwnership(CONFIG_PATH);
    if (changes > 0) log('INFO', `Auto-discovery: ${changes} changes applied to config`);

    if (!isFirstDiscovery && discoveries.length > 0) {
      await sendDiscoveryNotification(discoveries);
    }
  }
}

async function sendDiscoveryNotification(discoveries) {
  const lines = [];
  const newCategories = discoveries.filter(d => d.type === 'category');
  const newChannels = discoveries.filter(d => d.type === 'channel');
  const removedCategories = discoveries.filter(d => d.type === 'category-removed');
  const removedChannels = discoveries.filter(d => d.type === 'channel-removed');

  for (const cat of newCategories) {
    lines.push(`**New category: ${cat.name}** - \`DISABLED\``);
    lines.push(`Channels: ${cat.channels.join(', ')} (${cat.channels.length})`);
    lines.push(`Set \`enabled: true\` in config to activate cleanup\n`);
  }

  // Group new channels by category
  const byCategory = new Map();
  for (const ch of newChannels) {
    if (!byCategory.has(ch.category)) byCategory.set(ch.category, []);
    byCategory.get(ch.category).push(ch);
  }

  for (const [catName, channels] of byCategory) {
    for (const ch of channels) {
      const status = ch.enabled ? '' : ' · category disabled';
      lines.push(`**${catName}** - #${ch.name} added`);
      lines.push(`Cleanup: ${formatRetention(ch.retention)} (${ch.source} default)${status}`);
    }
  }

  // Removed categories
  for (const cat of removedCategories) {
    lines.push(`**Removed category: ${cat.name}** - ${cat.channelCount} channel${cat.channelCount !== 1 ? 's' : ''} removed from config`);
  }

  // Group removed channels by category
  const removedByCategory = new Map();
  for (const ch of removedChannels) {
    if (!removedByCategory.has(ch.category)) removedByCategory.set(ch.category, []);
    removedByCategory.get(ch.category).push(ch);
  }

  for (const [catName, channels] of removedByCategory) {
    const names = channels.map(ch => `#${ch.name}`).join(', ');
    lines.push(`**${catName}** - ${names} removed (deleted from Discord)`);
  }

  let description = lines.join('\n');
  if (description.length > 4000) {
    description = description.substring(0, 3990) + '\n... (truncated)';
  }

  // Discord notification
  const webhookUrl = config.webhooks.info;
  if (webhookUrl && !isAllowedDiscordWebhookUrl(webhookUrl)) {
    log('WARN', 'Auto-discovery info webhook URL is not a valid Discord webhook - refusing to send');
  } else if (webhookUrl) {
    const infoColor = parseInt((config.webhooks?.infoColor || '#f39c12').replace('#', ''), 16) || 0xf39c12;
    const embed = {
      title: 'Channel Auto-Discovery',
      description,
      color: infoColor,
      footer: { text: `${discoveries.length} change${discoveries.length !== 1 ? 's' : ''} detected · PurgeBot v${version} by ProphetSe7en` },
      timestamp: new Date().toISOString(),
    };

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log('WARN', `Info webhook response: ${res.status} - ${body}`);
      }
    } catch (err) {
      log('ERROR', `Info webhook failed: ${err.message}`);
    }
  }

  // Gotify notification
  await sendGotify('PurgeBot: Channel Auto-Discovery', description, 'info');
}

// --- Sort Notification ---

async function sendSortNotification(results) {
  const lines = [];

  // Category moves
  if (results.categories.length > 0) {
    lines.push(`**Categories sorted** - ${results.categories.length} repositioned`);
    for (const cat of results.categories) {
      lines.push(`· ${cat.name}: position ${cat.from} → ${cat.to}`);
    }
  }

  // Channel moves per category
  for (const catGroup of results.channels) {
    lines.push(`\n**${catGroup.category}** - ${catGroup.moves.length} channel${catGroup.moves.length !== 1 ? 's' : ''} sorted`);
  }

  if (lines.length === 0) return;

  let description = lines.join('\n');
  if (description.length > 4000) {
    description = description.substring(0, 3990) + '\n... (truncated)';
  }

  // Discord notification - use info webhook
  const webhookUrl = config.webhooks.info;
  if (webhookUrl && !isAllowedDiscordWebhookUrl(webhookUrl)) {
    log('WARN', 'Sort info webhook URL is not a valid Discord webhook - refusing to send');
  } else if (webhookUrl) {
    const infoColor = parseInt((config.webhooks?.infoColor || '#f39c12').replace('#', ''), 16) || 0xf39c12;
    const embed = {
      title: 'Server Sort',
      description,
      color: infoColor,
      footer: { text: `${results.totalMoves} item${results.totalMoves !== 1 ? 's' : ''} moved · PurgeBot v${version} by ProphetSe7en` },
      timestamp: new Date().toISOString(),
    };
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log('WARN', `Sort notification webhook response: ${res.status} - ${body}`);
      }
    } catch (err) {
      log('ERROR', `Sort notification webhook failed: ${err.message}`);
    }
  }

  // Gotify notification
  await sendGotify('PurgeBot: Server Sort', description, 'info');
}

// --- Gotify Notification ---

async function sendGotify(title, message, level = 'info') {
  if (!config.gotify?.enabled || !config.gotify.url || !config.gotify.token) return;
  if (!isAllowedGotifyUrl(config.gotify.url)) {
    log('WARN', 'Gotify URL is not a valid http(s) URL - refusing to send');
    return;
  }

  let priority;
  if (level === 'warning') {
    if (!config.gotify.priorityWarning) return;
    priority = config.gotify.warningValue ?? 5;
  } else {
    if (!config.gotify.priorityInfo) return;
    priority = config.gotify.infoValue ?? 3;
  }

  // Ensure markdown renders properly in Gotify
  let msg = message;
  msg = msg.replace(/\n\*\*/g, '\n\n**');
  msg = msg.replace(/\n- /g, '\n\n- ');
  while (msg.includes('\n\n\n')) msg = msg.replace(/\n\n\n/g, '\n\n');

  const url = `${config.gotify.url}/message?token=${encodeURIComponent(config.gotify.token)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        message: msg,
        priority,
        extras: { 'client::display': { contentType: 'text/markdown' } },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log('WARN', `Gotify notification failed: ${res.status} - ${body}`);
    }
  } catch (err) {
    log('ERROR', `Gotify notification failed: ${err.message}`);
  }
}

// --- Stats Persistence ---

const STATS_PATH = path.join(path.dirname(CONFIG_PATH), 'stats.json');

function persistStats(lastRun, { partial = false } = {}) {
  try {
    let data = { lastRun: null, history: [] };
    if (fs.existsSync(STATS_PATH)) {
      data = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    }
    data.lastRun = lastRun;
    if (!lastRun.dryRun) {
      data.lastLiveRun = lastRun;
    }

    // Partial (incremental) saves only update lastRun/lastLiveRun for crash recovery
    // History, lifetime, and per-category/channel totals are only updated on the final call
    if (partial) {
      const tmpPath = STATS_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, STATS_PATH);
      fixOwnership(STATS_PATH);
      return;
    }

    // Build per-category summary for this history entry
    const categorySummary = {};
    if (lastRun.categories) {
      for (const [catName, catData] of Object.entries(lastRun.categories)) {
        categorySummary[catName] = { purged: catData.purged || 0, errors: catData.errors || 0 };
      }
    }

    // Keep last 90 runs in history (~3 months)
    data.history.unshift({
      timestamp: lastRun.timestamp,
      purged: lastRun.totalPurged,
      errors: lastRun.totalErrors,
      dryRun: lastRun.dryRun,
      duration: lastRun.duration,
      trigger: lastRun.trigger || 'schedule',
      categories: categorySummary,
    });
    if (data.history.length > 90) data.history.length = 90;

    // Update lifetime + per-channel/category totals (live runs only, not dry-run)
    if (!lastRun.dryRun) {
      // Lifetime totals
      if (!data.lifetime) data.lifetime = { totalRuns: 0, totalPurged: 0, totalErrors: 0, firstRun: lastRun.timestamp };
      data.lifetime.totalRuns++;
      data.lifetime.totalPurged += lastRun.totalPurged;
      data.lifetime.totalErrors += lastRun.totalErrors;

      // Per-channel and per-category totals
      if (!data.channelTotals) data.channelTotals = {};
      if (!data.categoryTotals) data.categoryTotals = {};
      if (lastRun.categories) {
        for (const [catName, catData] of Object.entries(lastRun.categories)) {
          data.categoryTotals[catName] = (data.categoryTotals[catName] || 0) + (catData.purged || 0);
          for (const ch of catData.channels || []) {
            if (ch.purged > 0) {
              // Composite key avoids collisions when different categories have same channel name
              const chKey = catName + '/' + ch.name;
              data.channelTotals[chKey] = (data.channelTotals[chKey] || 0) + ch.purged;
            }
          }
        }
      }

      // Prune stale entries - keep top 200 channels and top 100 categories
      const chEntries = Object.entries(data.channelTotals);
      if (chEntries.length > 200) {
        chEntries.sort((a, b) => b[1] - a[1]);
        data.channelTotals = Object.fromEntries(chEntries.slice(0, 200));
      }
      const catEntries = Object.entries(data.categoryTotals);
      if (catEntries.length > 100) {
        catEntries.sort((a, b) => b[1] - a[1]);
        data.categoryTotals = Object.fromEntries(catEntries.slice(0, 100));
      }
    }

    const tmpPath = STATS_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, STATS_PATH);
    fixOwnership(STATS_PATH);
  } catch (err) {
    log('WARN', `Failed to persist stats: ${err.message}`);
  }
}

// --- Cleanup Logic ---

// (#9) Guard against concurrent cleanup runs
let cleanupRunning = false;
let cleanupCancelled = false;
let cleanupStartTime = null;
let sortRunning = false;

async function runCleanup(options = {}) {
  const { forceDryRun = false, forceLive = false, categoryFilter = null, channelFilter = null, trigger = 'schedule', ruleOnly = null } = options;
  // ruleOnly = { scope: 'global'|'category', categoryName?: string, ruleIdx: number }
  // When set: only that single rule fires for the run, retention is treated
  // as -1 (no age-based deletes), and ruleOnly.scope === 'category' forces
  // the category filter to ruleOnly.categoryName.
  let effectiveCategoryFilter = categoryFilter;
  if (ruleOnly && ruleOnly.scope === 'category' && ruleOnly.categoryName) {
    effectiveCategoryFilter = ruleOnly.categoryName;
  }
  // Pre-resolve the targeted rule for notification context. Falls back to
  // a generic phrasing if the rule disappeared between trigger and run.
  let ruleOnlyDescription = null;
  let ruleOnlyAction = null;
  if (ruleOnly) {
    const ro = ruleOnly.scope === 'global'
      ? config.rules?.[ruleOnly.ruleIdx]
      : config.categories?.[ruleOnly.categoryName]?.rules?.[ruleOnly.ruleIdx];
    if (ro) {
      ruleOnlyDescription = describeRule(ro);
      ruleOnlyAction = ro.action || 'delete';
    }
  }

  if (cleanupRunning) {
    log('WARN', 'Cleanup already running, skipping');
    return;
  }
  cleanupRunning = true;
  cleanupCancelled = false;
  cleanupStartTime = Date.now();

  const startTime = Date.now();
  const runRlStart = rateLimitTracker.totalMs;
  const runRlHitsStart = rateLimitTracker.hits;
  let effectiveDryRun = forceDryRun;

  try {
    // (#10) Hot-reload config - don't crash on parse errors
    loadConfig(false);
    effectiveDryRun = forceLive ? false : (config.dryRun || forceDryRun);
    let filterLabel = effectiveCategoryFilter ? ` [category: ${effectiveCategoryFilter}]` : '';
    if (channelFilter) filterLabel += ` [channel: #${channelFilter}]`;
    log('INFO', `Starting cleanup run (dryRun=${effectiveDryRun})${filterLabel}`);
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
      log('ERROR', `Guild ${GUILD_ID} not found`);
      logEmitter.emit('cleanup-complete', { timestamp: new Date().toISOString(), error: `Guild ${GUILD_ID} not found`, totalProcessed: 0, totalPurged: 0, totalErrors: 1, dryRun: effectiveDryRun, duration: Date.now() - startTime, trigger, categories: {} });
      return;
    }

    // Fetch all channels fresh
    await guild.channels.fetch();

    // Auto-discover new channels/categories before cleanup
    await autoDiscoverChannels(guild);

    let totalProcessed = 0;
    let totalPurged = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalScanned = 0;

    // Build category map from Discord: catName → [channel objects]
    const discordCategories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory);
    const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText && c.parentId);

    const categoryChannelMap = new Map();
    for (const [, channel] of textChannels) {
      const category = discordCategories.get(channel.parentId);
      if (!category) continue;
      if (!categoryChannelMap.has(category.name)) categoryChannelMap.set(category.name, []);
      categoryChannelMap.get(category.name).push(channel);
    }

    const categoryStats = {};

    function emitProgress(data) {
      logEmitter.emit('cleanup-progress', data);
    }

    // Process each enabled category - only channels in _channels (allow-list)
    for (const [catName, channels] of categoryChannelMap) {
      if (cleanupCancelled) {
        log('INFO', 'Cleanup cancelled by user');
        break;
      }
      if (!isEnabled(catName)) {
        totalSkipped += channels.length;
        continue;
      }

      // Category filter (for Test tab single-category dry-run)
      if (effectiveCategoryFilter && catName !== effectiveCategoryFilter) {
        continue;
      }

      const allowedChannels = getConfiguredChannels(catName);
      const cat = config.categories[catName];
      const deleteOld = cat.deleteOld !== false; // defaults to true
      const channelResults = [];
      const catStart = Date.now();
      let catErrors = false;
      const allowedCount = [...channels].filter(c => allowedChannels.has(c.name)).length;
      let channelIndex = 0;

      log('INFO', `Processing category "${catName}" (${allowedCount} channels)`);

      for (const channel of channels) {
        if (cleanupCancelled) break;
        const chanName = channel.name;

        // Only process channels explicitly listed in _channels
        if (!allowedChannels.has(chanName)) {
          totalSkipped++;
          continue;
        }

        // Channel filter (for per-channel cleanup from UI)
        if (channelFilter && chanName !== channelFilter) {
          continue;
        }

        channelIndex++;
        totalProcessed++;
        log('INFO', `  Scanning ${catName}/#${chanName} (${channelIndex}/${allowedCount})`);
        emitProgress({ category: catName, currentChannel: chanName, channelIndex, channelCount: allowedCount, dryRun: effectiveDryRun });

        // In ruleOnly mode the user is testing one specific rule. Treat
        // retention as "never" so the result is purely the rule's effect,
        // and filter the leveled-rules list down to just that one rule.
        const retention = ruleOnly ? -1 : getRetention(catName, chanName);
        const retentionSource = ruleOnly ? 'rule-only' : getRetentionSource(catName, chanName);
        let leveledRules = getEffectiveRules(config.rules, cat, catName, chanName);
        if (ruleOnly) {
          const targetRule = ruleOnly.scope === 'global'
            ? config.rules?.[ruleOnly.ruleIdx]
            : cat.rules?.[ruleOnly.ruleIdx];
          leveledRules = targetRule
            ? leveledRules.filter(lr => lr.rule === targetRule)
            : [];
        }
        const hasAnyRules = leveledRules.length > 0;
        const deleteRuleCount = leveledRules.filter(lr => lr.rule.action === 'delete').length;
        const keepRuleCount = leveledRules.filter(lr => lr.rule.action === 'keep').length;

        // Skip the channel only when retention is -1 AND no rules apply.
        // With rules in play we still scan, since a rule may match individual
        // messages even when age-based deletion is off.
        if (retention === -1 && !hasAnyRules) {
          const result = { name: chanName, skipped: true };
          channelResults.push(result);
          emitProgress({ category: catName, channel: result, totalProcessed, totalPurged, totalErrors, dryRun: effectiveDryRun });
          continue;
        }

        const chanStart = Date.now();
        const rlStart = rateLimitTracker.totalMs;

        // Calculate cutoff date
        const now = new Date();
        const cutoff = new Date(now.getTime() - retention * 24 * 60 * 60 * 1000);
        const bulkDeleteLimit = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

        try {
          // bulkDeletable: messages ≤14d we'll batch via Discord's bulk API
          // (fast, no per-message rate limit). oldByRetention vs oldByRule:
          // two separate >14d buckets so the maxOldDeletesPerChannel budget
          // can prioritise retention-old over rule-old when both compete.
          let bulkDeletable = [];
          let oldByRetention = [];
          let oldByRule = [];
          let keptByRule = 0;
          let deletedByRule = 0;
          const ruleConflicts = [];
          let lastId = undefined;
          let fetched = 0;
          let oldestScannedMsg = null;
          const maxMessages = config.discord.maxMessagesPerChannel;

          while (fetched < maxMessages) {
            const batchSize = Math.min(100, maxMessages - fetched);
            const options = { limit: batchSize };
            if (lastId) options.before = lastId;

            const messages = await channel.messages.fetch(options);
            if (messages.size === 0) break;

            for (const [, msg] of messages) {
              // Rules first: most-specific tier with any match decides;
              // keep wins over delete inside that tier.
              if (hasAnyRules) {
                const r = evaluateMessageRules(msg, leveledRules);
                if (r.decision === 'keep') {
                  keptByRule++;
                  if (r.conflict) {
                    ruleConflicts.push({
                      messageId: msg.id,
                      author: msg.author?.tag || msg.author?.username || msg.author?.id || 'unknown',
                      tier: r.tier,
                      keepRule: r.keepMatches[0].rule,
                      deleteRule: r.deleteMatches[0].rule,
                    });
                    const keepMore = r.keepMatches.length > 1 ? ` (+${r.keepMatches.length - 1} more)` : '';
                    const delMore = r.deleteMatches.length > 1 ? ` (+${r.deleteMatches.length - 1} more)` : '';
                    log('WARN', `  ${catName}/#${chanName}: rule conflict on message ${msg.id} at ${r.tier} level (kept by ${describeRule(r.keepMatches[0].rule)}${keepMore}; would have been deleted by ${describeRule(r.deleteMatches[0].rule)}${delMore})`);
                  }
                  continue;
                }
                if (r.decision === 'delete') {
                  // First matching delete-rule decides attribution. Carry the
                  // rule + winning condition group so the UI can show "matched
                  // word \"test\"" per message.
                  const winning = r.deleteMatches[0];
                  const reason = {
                    kind: 'rule', rule: winning.rule, conditions: winning.conditions, tier: r.tier,
                  };
                  if (msg.createdAt > bulkDeleteLimit) {
                    bulkDeletable.push({ msg, reason });
                    deletedByRule++;
                  } else {
                    // Rule wanted delete on a >14d message. deleteOld gates
                    // the RETENTION path (skipping slow individual deletes
                    // when the user wants fast bulk-only runs) - but a rule
                    // match is an explicit user intent, so honour it even
                    // when deleteOld is false. The maxOldDeletesPerChannel
                    // budget still caps per-run throughput.
                    oldByRule.push({ msg, reason });
                    deletedByRule++;
                  }
                  continue;
                }
              }

              // Rules didn't decide (or there were none). Apply the global
              // skipPinned default before age-based retention so an existing
              // user who relied on the Settings checkbox still sees pinned
              // messages preserved when no rule overrides that decision.
              if (msg.pinned && config.discord.skipPinned) continue;

              // Fall through to age-based retention. retention=-1 here means
              // "rules didn't match and the configured retention is never" -
              // leave the message alone.
              if (retention === -1) continue;
              if (msg.createdAt < cutoff) {
                const reason = { kind: 'retention', retention };
                if (msg.createdAt > bulkDeleteLimit) {
                  bulkDeletable.push({ msg, reason });
                } else if (deleteOld) {
                  oldByRetention.push({ msg, reason });
                }
              }
            }

            // Discord returns batches newest-first, so the last entry in each
            // batch is the oldest of that batch - and the oldest scanned so
            // far overall after the loop exits.
            oldestScannedMsg = messages.last();
            lastId = messages.last().id;
            fetched += messages.size;
            // If this batch was smaller than the asked-for limit, we've hit
            // the end of the channel - no point asking again.
            if (messages.size < batchSize) break;
          }
          const scanComplete = fetched < maxMessages;

          // Shared old-message budget: retention prioritised, rule-old fills
          // the rest of the cap. Anything beyond cap waits for the next run.
          const maxOld = config.discord.maxOldDeletesPerChannel;
          const oldRetentionToDelete = oldByRetention.slice(0, maxOld);
          const oldRuleBudget = Math.max(0, maxOld - oldRetentionToDelete.length);
          const oldRuleToDelete = oldByRule.slice(0, oldRuleBudget);
          const oldToDeleteCombined = [...oldRetentionToDelete, ...oldRuleToDelete];
          const totalOldQueued = oldByRetention.length + oldByRule.length;

          const totalDeletable = bulkDeletable.length + totalOldQueued;
          let deleted = 0;
          let failedDeletes = 0;
          const retentionLabel = retention === -1 ? 'never' : `${retention}d`;

          if (totalDeletable === 0) {
            // Surface keep-rule activity even when nothing was deleted - a
            // run that only protected messages is still meaningful signal.
            const protectedNote = keptByRule > 0 ? `, ${keptByRule} protected by rule` : '';
            const tail = hasAnyRules
              ? `${fetched} scanned, retention=${retentionLabel}, ${deleteRuleCount} delete-rule(s), ${keepRuleCount} keep-rule(s)${protectedNote}`
              : `${fetched} scanned, retention=${retentionLabel}`;
            log('INFO', `  ${catName}/#${chanName}: 0 messages to delete (${tail})`);
          } else if (effectiveDryRun) {
            const cappedOld = oldToDeleteCombined.length;
            const wouldDelete = bulkDeletable.length + cappedOld;
            let detail = `${bulkDeletable.length} bulk`;
            if (deletedByRule > 0) detail += ` (incl. ${deletedByRule} by rule)`;
            if (cappedOld > 0) detail += ` + ${cappedOld} old (>14d)`;
            if (totalOldQueued > maxOld) detail += `, ${totalOldQueued - maxOld} old waiting`;
            if (keptByRule > 0) detail += `, ${keptByRule} protected by rule`;
            const bulkOnly = !deleteOld && totalOldQueued === 0 ? ' (bulk only)' : '';
            log('INFO', `[DRY RUN] ${catName}/#${chanName}: would delete ${wouldDelete} messages (${detail}, retention=${retentionLabel})${bulkOnly}`);
            totalPurged += wouldDelete;
          } else {
            // Bulk delete (≤14d). (#3) filterOld=true prevents error if a
            // message aged past 14d between fetch and delete.
            for (let i = 0; i < bulkDeletable.length; i += 100) {
              if (cleanupCancelled) break;
              const batch = bulkDeletable.slice(i, i + 100);
              const msgBatch = batch.map(e => e.msg);
              if (msgBatch.length === 1) {
                try {
                  await msgBatch[0].delete();
                  deleted++;
                } catch (delErr) {
                  failedDeletes++;
                  log('WARN', `${catName}/#${chanName}: failed to delete message ${msgBatch[0].id}: ${delErr.message}`);
                }
              } else {
                const result = await channel.bulkDelete(msgBatch, true);
                deleted += result.size;
              }
            }

            // Individual delete (>14d): retention-old first, then rule-old.
            if (oldToDeleteCombined.length > 0) {
              log('INFO', `  ${catName}/#${chanName}: removing ${oldToDeleteCombined.length} messages older than 14 days, one at a time (Discord limits this, so roughly ${formatDuration(oldToDeleteCombined.length * 3000)})...`);
            }
            let oldDeletedCount = 0;
            for (const entry of oldToDeleteCombined) {
              if (cleanupCancelled) break;
              const msg = entry.msg;
              try {
                await msg.delete();
                deleted++;
                oldDeletedCount++;
                if (oldDeletedCount % 10 === 0 && oldDeletedCount < oldToDeleteCombined.length) {
                  log('INFO', `  ${catName}/#${chanName}: ${oldDeletedCount}/${oldToDeleteCombined.length} old messages deleted...`);
                }
              } catch (delErr) {
                failedDeletes++;
                log('WARN', `${catName}/#${chanName}: failed to delete message ${msg.id}: ${delErr.message}`);
              }
              await sleep(config.discord.delayBetweenDeletes);
            }
            if (totalOldQueued > maxOld) {
              log('WARN', `${catName}/#${chanName}: ${totalOldQueued - maxOld} messages older than 14 days still waiting (PurgeBot removes up to ${maxOld} of these per run)`);
            }

            const chanWaitMs = rateLimitTracker.totalMs - rlStart;
            const waitNote = chanWaitMs >= 1000 ? `, ${formatDuration(chanWaitMs)} of that waiting on Discord rate limits` : '';
            const ruleNote = deletedByRule > 0 ? `, ${deletedByRule} matched a rule` : '';
            log('INFO', `${catName}/#${chanName}: deleted ${deleted} messages${ruleNote} in ${formatDuration(Date.now() - chanStart)}${waitNote} (retention=${retentionLabel})`);
            totalPurged += deleted;
          }

          const cappedTotal = bulkDeletable.length + Math.min(totalOldQueued, maxOld);
          const purgedCount = effectiveDryRun ? cappedTotal : deleted;

          // Attribution rollup - per-entry source bucket.
          const bulkByRule = bulkDeletable.filter(e => e.reason.kind === 'rule').length;
          const bulkByRetention = bulkDeletable.length - bulkByRule;
          const oldByRuleQueued = oldRuleToDelete.length;
          const oldByRetentionQueued = oldRetentionToDelete.length;
          const oldByRuleWaiting = Math.max(0, oldByRule.length - oldRuleToDelete.length);
          const oldByRetentionWaiting = Math.max(0, oldByRetention.length - oldRetentionToDelete.length);
          const rollup = {
            bulk: bulkDeletable.length,
            old: oldToDeleteCombined.length,
            oldWaiting: Math.max(0, totalOldQueued - maxOld),
            byRule: bulkByRule + oldByRuleQueued,
            byRetention: bulkByRetention + oldByRetentionQueued,
            byRuleWaiting: oldByRuleWaiting,
            byRetentionWaiting: oldByRetentionWaiting,
          };

          // Per-message attribution. Cap at MAX_ATTR_PER_CHAN per channel so
          // the SSE payload + the run-history file stay bounded. UI surfaces
          // "and X more" when truncated.
          const MAX_ATTR_PER_CHAN = 200;
          function snippetOf(msg) {
            const text = extractMessageText(msg);
            const oneLine = text.replace(/\s+/g, ' ').trim();
            return oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine;
          }
          function buildAttribution(entry, age) {
            const a = {
              id: entry.msg.id,
              ts: entry.msg.createdAt?.toISOString?.() || new Date().toISOString(),
              author: entry.msg.author?.tag || entry.msg.author?.username || entry.msg.author?.id || 'unknown',
              snippet: snippetOf(entry.msg),
              age, // 'bulk' (≤14d) or 'old' (>14d)
            };
            if (entry.reason.kind === 'rule') {
              a.reason = 'rule';
              a.ruleNote = entry.reason.rule.note || null;
              a.ruleDescription = describeRule(entry.reason.rule);
              a.matchedConditions = entry.reason.conditions.map(describeCondition);
              a.tier = entry.reason.tier;
            } else {
              a.reason = 'retention';
              a.retentionDays = entry.reason.retention;
            }
            return a;
          }
          const allEntries = [
            ...bulkDeletable.map(e => ({ ...e, _age: 'bulk' })),
            ...oldToDeleteCombined.map(e => ({ ...e, _age: 'old' })),
          ];
          const attribution = allEntries.slice(0, MAX_ATTR_PER_CHAN).map(e => buildAttribution(e, e._age));
          const attributionTruncated = Math.max(0, allEntries.length - attribution.length);
          // Old messages that exceed maxOld budget aren't shown individually
          // (we never even fetched them past the slice cap), but we expose
          // the breakdown so the UI can say "+12 old by rule still waiting".
          const waiting = {
            oldByRule: oldByRuleWaiting,
            oldByRetention: oldByRetentionWaiting,
          };

          // Audit per channel - gives "what got deleted where" + the rollup.
          // No per-message lines (they live in run-history; audit stays terse).
          if (deleted > 0 || failedDeletes > 0 || effectiveDryRun) {
            audit.record('discord.delete_batch', {
              actor: { kind: 'bot' },
              details: {
                category: catName,
                channel: chanName,
                deleted,
                deletedByRule,
                failed: failedDeletes,
                dryRun: effectiveDryRun,
                retention: retentionLabel,
                trigger,
                rollup,
              },
            });
          }

          // Per-channel warnings in plain language so the dashboard and
          // notifications stay readable without diving into the log.
          const warnings = [];
          const oldRemaining = Math.max(0, totalOldQueued - maxOld);
          if (oldRemaining > 0) {
            const runsLeft = Math.ceil(oldRemaining / maxOld);
            warnings.push(`${oldRemaining} message${oldRemaining !== 1 ? 's' : ''} older than 14 days ${oldRemaining !== 1 ? 'are' : 'is'} still waiting. Discord only lets PurgeBot remove a limited number of these each run, so this channel finishes over about ${runsLeft} more run${runsLeft !== 1 ? 's' : ''}.`);
          }
          if (failedDeletes > 0) {
            warnings.push(`PurgeBot couldn't remove ${failedDeletes} message${failedDeletes !== 1 ? 's' : ''} here, possibly because it's missing permission to manage messages in this channel.`);
          }
          if (ruleConflicts.length > 0) {
            warnings.push(`${ruleConflicts.length} message${ruleConflicts.length !== 1 ? 's' : ''} matched both a keep rule and a delete rule. Keep won, so nothing was removed; review the rule list if that wasn't the intent.`);
          }

          channelResults.push({
            name: chanName, retention, retentionSource, purged: purgedCount,
            durationMs: Date.now() - chanStart,
            rateLimitMs: rateLimitTracker.totalMs - rlStart,
            oldRemaining,
            warnings,
            keptByRule,
            deletedByRule,
            ruleConflicts: ruleConflicts.length,
            rollup,
            attribution,
            attributionTruncated,
            waiting,
            scannedCount: fetched,
            scanLimit: maxMessages,
            scanComplete,
            oldestScannedAt: oldestScannedMsg?.createdAt?.toISOString?.() || null,
          });
        } catch (err) {
          log('ERROR', `${catName}/#${chanName}: ${err.message}`);
          channelResults.push({
            name: chanName, retention, retentionSource, purged: 0,
            error: humanizeError(err.message),
            durationMs: Date.now() - chanStart,
          });
          catErrors = true;
          totalErrors++;
        }

        emitProgress({
          category: catName,
          channel: channelResults[channelResults.length - 1],
          totalProcessed, totalPurged, totalErrors,
          dryRun: effectiveDryRun,
        });

        // Skip delay if channel had nothing to delete (no rate limit consumed)
        const lastResult = channelResults[channelResults.length - 1];
        if (lastResult.purged > 0 || lastResult.error) {
          await sleep(config.discord.delayBetweenChannels);
        }
      }

      // Collect per-category stats
      const catPurged = channelResults.reduce((sum, ch) => sum + (ch.purged || 0), 0);
      const catErrors_count = channelResults.filter(ch => ch.error).length;
      const catDeletedByRule = channelResults.reduce((sum, ch) => sum + (ch.deletedByRule || 0), 0);
      const catKeptByRule = channelResults.reduce((sum, ch) => sum + (ch.keptByRule || 0), 0);
      const catRuleConflicts = channelResults.reduce((sum, ch) => sum + (ch.ruleConflicts || 0), 0);
      const catScanned = channelResults.reduce((sum, ch) => sum + (ch.scannedCount || 0), 0);
      totalScanned += catScanned;
      categoryStats[catName] = {
        processed: channelResults.length,
        purged: catPurged,
        errors: catErrors_count,
        deletedByRule: catDeletedByRule,
        keptByRule: catKeptByRule,
        ruleConflicts: catRuleConflicts,
        scanned: catScanned,
        durationMs: Date.now() - catStart,
        channels: channelResults,
      };

      // Send per-category webhook immediately (live runs only)
      const hasPurged = channelResults.some(ch => ch.purged > 0);
      if (!effectiveDryRun && (hasPurged || catErrors)) {
        const embed = buildCategoryEmbed(catName, channelResults, catErrors, effectiveDryRun, {
          ruleOnly: !!ruleOnly,
          ruleDescription: ruleOnlyDescription,
          ruleAction: ruleOnlyAction,
        });
        await sendWebhook([embed]);
      }

      // Checkpoint stats after each category for crash recovery (only updates lastRun/lastLiveRun)
      const partialDuration = Date.now() - startTime;
      const partialRunStats = {
        timestamp: new Date().toISOString(),
        totalProcessed, totalPurged, totalErrors, totalScanned,
        dryRun: effectiveDryRun, duration: partialDuration, trigger,
        cancelled: cleanupCancelled,
        categories: categoryStats,
      };
      persistStats(partialRunStats, { partial: true });
    }

    // (#5) Summary log - correct count in both modes
    const cancelled = cleanupCancelled;
    const action = effectiveDryRun ? 'would delete' : 'deleted';
    log('INFO', `Cleanup ${cancelled ? 'cancelled' : 'complete'}: ${totalProcessed} channels processed, ${totalPurged} messages ${action}, ${totalSkipped} skipped, ${totalErrors} errors`);

    // Surface how much of this run was spent waiting on Discord's rate
    // limits (mostly the strict limit on removing messages older than 14
    // days). Confirms whether slow runs are Discord throttling vs our work.
    const runRlMs = rateLimitTracker.totalMs - runRlStart;
    const runRlHits = rateLimitTracker.hits - runRlHitsStart;
    if (runRlMs >= 1000) {
      log('INFO', `This run spent ${formatDuration(runRlMs)} waiting on Discord rate limits (${runRlHits} times). Removing messages older than 14 days is limited by Discord, not PurgeBot.`);
    }

    // Persist final stats to stats.json (overwrites incremental data with complete run)
    const duration = Date.now() - startTime;
    const runStats = {
      timestamp: new Date().toISOString(),
      totalProcessed, totalPurged, totalErrors, totalScanned,
      dryRun: effectiveDryRun, duration, trigger,
      cancelled,
      categories: categoryStats,
      ruleOnly: ruleOnly || null,
      ruleDescription: ruleOnlyDescription,
      ruleAction: ruleOnlyAction,
    };
    persistStats(runStats);

    // Send summary notification to info webhook (live runs only)
    await sendSummaryNotification(runStats);

    // Post-cleanup tasks (scheduled runs only, not manual, not dry-run)
    if (!effectiveDryRun && trigger === 'schedule') {

      // 1. Auto-sync - discover new/removed channels before sorting
      try {
        log('INFO', 'Post-cleanup sync: checking for channel changes...');
        await syncConfig({ exitOnError: false });
      } catch (err) {
        log('ERROR', `Post-cleanup sync failed: ${err.message}`);
      }

      // 2. Webhook discovery - log server webhooks
      if (config.webhookDiscoveryOnSchedule) {
        try {
          const whData = await fetchGuildWebhooks();
          log('INFO', `Webhook discovery: ${whData.total} webhook${whData.total !== 1 ? 's' : ''} across ${whData.categories.length} categor${whData.categories.length !== 1 ? 'ies' : 'y'}`);
        } catch (err) {
          log('ERROR', `Webhook discovery failed: ${err.message}`);
        }
      }

      // 3. Auto-sort - sort categories and channels
      if (config.sortEnabled && config.sortAfterCleanup) {
        sortRunning = true;
        try {
          const allCats = Object.keys(config.categories || {});
          const included = config.sortInclude || {};
          const skipCats = allCats.filter(name => !included[name]);
          const sortResults = await sortServer({ mode: 'both', dryRun: false, skipChannelsInCategories: skipCats, includeVoice: !!config.sortIncludeVoice, pinnedPositions: config.sortPinned || {} });
          if (sortResults.totalMoves > 0) {
            log('INFO', `Auto-sort: ${sortResults.totalMoves} items sorted`);
            await sendSortNotification(sortResults);
          }
        } catch (err) {
          log('ERROR', `Auto-sort failed: ${err.message}`);
        } finally {
          sortRunning = false;
        }
      }
    }

    // Notify UI via SSE that cleanup is complete
    logEmitter.emit('cleanup-complete', runStats);

    // (#6) Update heartbeat after successful run
    writeHeartbeat();
  } catch (err) {
    log('ERROR', `Cleanup failed: ${err.message}`);
    logEmitter.emit('cleanup-complete', {
      timestamp: new Date().toISOString(),
      error: err.message,
      totalProcessed: 0, totalPurged: 0, totalErrors: 1,
      dryRun: effectiveDryRun, duration: Date.now() - startTime, trigger,
      categories: {},
    });
  } finally {
    cleanupRunning = false;
    cleanupCancelled = false;
    cleanupStartTime = null;
  }
}

// --- Config Sync (--sync flag) ---

async function syncConfig({ exitOnError = true } = {}) {
  log('INFO', 'Syncing config with Discord channels...');
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    log('ERROR', `Guild ${GUILD_ID} not found`);
    if (exitOnError) process.exit(1);
    throw new Error(`Guild ${GUILD_ID} not found`);
  }

  await guild.channels.fetch();

  const discordCategories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory);
  const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText && c.parentId);

  // Build map: categoryName → [channelNames]
  const discoveredMap = new Map();
  for (const [, channel] of textChannels) {
    const category = discordCategories.get(channel.parentId);
    if (!category) continue;
    if (!discoveredMap.has(category.name)) discoveredMap.set(category.name, []);
    discoveredMap.get(category.name).push(channel.name);
  }

  let changes = 0;
  const changeDetails = [];

  // Add new categories + check existing ones
  for (const [catName, channels] of discoveredMap) {
    const sortedChannels = [...channels].sort();

    if (!config.categories[catName]) {
      // New category - add as disabled with channel list
      config.categories[catName] = { enabled: false, default: config.globalDefault, _channels: sortedChannels };
      changes++;
      changeDetails.push({ type: 'added', scope: 'category', category: catName, channels: sortedChannels });
      log('INFO', `+ Category "${catName}" (DISABLED, default: ${config.globalDefault}d) - ${channels.length} channels: ${channels.join(', ')}`);
    } else {
      const cat = config.categories[catName];
      const status = cat.enabled ? 'enabled' : 'DISABLED';

      // Build map of existing inline overrides to preserve
      const existingOverrides = new Map();
      if (Array.isArray(cat._channels)) {
        for (const entry of cat._channels) {
          if (typeof entry === 'object' && entry !== null) {
            const name = Object.keys(entry)[0];
            existingOverrides.set(name, entry[name]);
          }
        }
      }

      // (#8) Migrate old overrides section to inline format
      if (cat.overrides) {
        for (const [chanName, value] of Object.entries(cat.overrides)) {
          if (!chanName.startsWith('_')) existingOverrides.set(chanName, value);
        }
        delete cat.overrides;
        changes++;
        changeDetails.push({ type: 'migrated', scope: 'overrides', category: catName });
        log('INFO', `  ${catName}: migrated overrides to inline format`);
      }

      // Rebuild channel list: sorted, preserving inline overrides
      const discordSet = new Set(sortedChannels);
      const existingNames = new Set((cat._channels || []).map(ch => typeof ch === 'object' ? Object.keys(ch)[0] : ch));
      const newList = sortedChannels.map(name => {
        if (existingOverrides.has(name)) return { [name]: existingOverrides.get(name) };
        return name;
      });

      // Track added channels
      const addedChannels = sortedChannels.filter(name => !existingNames.has(name));
      if (addedChannels.length > 0) {
        changeDetails.push({ type: 'added', scope: 'channel', category: catName, channels: addedChannels });
      }

      // Track removed channels (and warn about overrides)
      const removedChannels = [];
      for (const name of existingNames) {
        if (!discordSet.has(name)) {
          removedChannels.push(name);
        }
      }
      for (const [name] of existingOverrides) {
        if (!discordSet.has(name)) {
          log('WARN', `  ${catName}/#${name}: override removed (channel no longer on Discord)`);
          changes++;
        }
      }
      if (removedChannels.length > 0) {
        changeDetails.push({ type: 'removed', scope: 'channel', category: catName, channels: removedChannels });
      }

      const oldList = JSON.stringify(cat._channels || []);
      const newListStr = JSON.stringify(newList);
      if (oldList !== newListStr) {
        cat._channels = newList;
        changes++;
      }

      log('INFO', `  Category "${catName}" (${status}, default: ${cat.default ?? config.globalDefault}d) - ${channels.length} channels`);
    }
  }

  // Remove categories no longer on Discord
  for (const catName of Object.keys(config.categories)) {
    if (!discoveredMap.has(catName)) {
      const removedChannels = (config.categories[catName]._channels || []).map(ch => typeof ch === 'object' ? Object.keys(ch)[0] : ch);
      changeDetails.push({ type: 'removed', scope: 'category', category: catName, channels: removedChannels });
      delete config.categories[catName];
      changes++;
      log('WARN', `Category "${catName}": not found on Discord - removed from config`);
    }
  }

  // (#7) Only write config when there are actual changes
  if (changes > 0) {
    const yamlStr = yaml.dump(configForDisk(), { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false });
    const tmpPath = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, CONFIG_HEADER + yamlStr, 'utf8');
    fs.renameSync(tmpPath, CONFIG_PATH);
    fixOwnership(CONFIG_PATH);
    log('INFO', `Config updated: ${changes} changes written to ${CONFIG_PATH}`);
  } else {
    log('INFO', 'No changes - config is up to date');
  }

  log('INFO', `Sync complete: ${discoveredMap.size} categories, ${textChannels.size} channels on Discord`);

  return { categories: discoveredMap.size, channels: textChannels.size, changes, details: changeDetails };
}

// --- Cron Scheduling ---

let cronJob = null;

let lastCronDesc = '';

function setupCron() {
  const hadCron = !!cronJob;
  const prevDesc = lastCronDesc;
  if (cronJob) { cronJob.stop(); cronJob = null; lastCronDesc = ''; }

  if (!config.scheduleEnabled) {
    if (hadCron) log('INFO', 'Schedule disabled - previous schedule stopped');
    else log('INFO', 'Schedule disabled - cleanup runs manually only');
    return;
  }

  const schedule = config.schedule;
  if (!cron.validate(schedule)) {
    log('ERROR', `Invalid cron schedule: "${schedule}"`);
    return;
  }

  cronJob = cron.schedule(schedule, () => {
    log('INFO', 'Cron triggered cleanup');
    runCleanup().catch(err => log('ERROR', `Cleanup failed: ${err.message}`));
  }, { timezone: config.timezone });

  const newDesc = `"${schedule}" (${config.timezone})`;
  lastCronDesc = newDesc;
  if (hadCron && prevDesc && prevDesc !== newDesc) {
    log('INFO', `Cron rescheduled: ${newDesc} (was ${prevDesc})`);
  } else {
    log('INFO', `Cron scheduled: ${newDesc}`);
  }
}

// --- Startup ---

client.once('clientReady', () => {
  log('INFO', `Logged in as ${client.user.tag}`);
  log('INFO', `Guild: ${GUILD_ID}`);

  // Liveness heartbeat - written every 5 min (plus on startup and after
  // each cleanup run, see writeHeartbeat callers). The healthcheck in
  // Dockerfile rejects the container if this file stops being updated.
  // Earlier versions only wrote on startup + scheduled-run completion,
  // so containers with schedule disabled (or no matching categories)
  // went unhealthy after 28 h and Docker restarted them in a loop.
  writeHeartbeat();
  setInterval(writeHeartbeat, 5 * 60 * 1000);

  // Sync config with Discord channels if --sync flag
  if (process.argv.includes('--sync')) {
    syncConfig()
      .then(() => { log('INFO', 'Sync done, exiting'); process.exit(0); })
      .catch(err => { log('ERROR', `Sync failed: ${err.message}`); process.exit(1); });
    return;
  }

  setupCron();

  // Run immediately and exit if --now flag
  if (process.argv.includes('--now')) {
    log('INFO', 'Running cleanup immediately (--now flag)');
    runCleanup()
      .then(() => { log('INFO', 'Done, exiting'); process.exit(0); })
      .catch(err => { log('ERROR', `Cleanup failed: ${err.message}`); process.exit(1); });
    return;
  }
});

// --- Graceful Shutdown ---

let httpServer = null;

function shutdown(signal) {
  log('INFO', `Received ${signal}, shutting down...`);
  if (cronJob) cronJob.stop();
  if (httpServer) httpServer.close();
  client.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  log('ERROR', `Unhandled rejection: ${err?.message || err}`);
});
client.on('error', (err) => {
  log('ERROR', `Discord client error: ${err.message}`);
});

// Guild allowlist - leave any guild that isn't the configured GUILD_ID.
// Self-defense if the bot token leaks and an attacker invites the bot to
// a guild they control: without this, the bot stays silently and exposes
// any code path that touches `client.guilds.cache.first()` (which we have
// already audited away).
client.on('guildCreate', async (guild) => {
  if (guild.id === GUILD_ID) return;
  log('WARN', `Bot added to unexpected guild "${guild.name}" (${guild.id}) - leaving immediately`);
  audit.record('discord.guild_allowlist_violation', {
    actor: { kind: 'bot' },
    details: { guildId: guild.id, guildName: guild.name, allowed: GUILD_ID },
  });
  try {
    await guild.leave();
  } catch (err) {
    log('ERROR', `Failed to leave unexpected guild ${guild.id}: ${err.message}`);
  }
});

// --- Webhook Discovery ---

async function fetchGuildWebhooks() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error('Guild not available - bot may still be connecting');

  const webhooks = await guild.fetchWebhooks();

  // Build category → channel → webhooks structure
  const categoryMap = new Map();

  for (const wh of webhooks.values()) {
    const channel = guild.channels.cache.get(wh.channelId);
    const channelName = channel?.name || `unknown-${wh.channelId}`;
    const parentId = channel?.parentId || null;
    const parent = parentId ? guild.channels.cache.get(parentId) : null;
    const categoryName = parent?.name || 'Uncategorized';
    const categoryId = parentId || '__uncategorized__';

    if (!categoryMap.has(categoryId)) {
      categoryMap.set(categoryId, { name: categoryName, id: categoryId, channels: new Map() });
    }
    const cat = categoryMap.get(categoryId);
    if (!cat.channels.has(wh.channelId)) {
      cat.channels.set(wh.channelId, { name: channelName, webhooks: [] });
    }
    cat.channels.get(wh.channelId).webhooks.push({
      id: wh.id,
      name: wh.name,
      url: wh.url,
      avatar: wh.avatarURL({ size: 32 }),
      type: wh.type === 1 ? 'Incoming' : wh.type === 2 ? 'Channel Follower' : wh.type === 3 ? 'Application' : 'Unknown',
      creator: wh.owner?.username || null,
      createdAt: wh.createdAt?.toISOString() || null,
    });
  }

  // Sort categories alphabetically, Uncategorized last
  const sorted = [...categoryMap.values()].sort((a, b) => {
    if (a.id === '__uncategorized__') return 1;
    if (b.id === '__uncategorized__') return -1;
    return a.name.localeCompare(b.name);
  });

  const categories = sorted.map(cat => {
    const channels = [...cat.channels.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(ch => ({ name: ch.name, webhooks: ch.webhooks }));
    return {
      category: cat.name,
      channelCount: channels.length,
      webhookCount: channels.reduce((sum, ch) => sum + ch.webhooks.length, 0),
      channels,
    };
  });

  return {
    total: webhooks.size,
    categories,
  };
}

// --- Purge All (channel recreate) ---

async function purgeAllChannel(categoryName, channelName, channelId) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error('Guild not available - bot may still be connecting');

  await guild.channels.fetch();

  let channel;
  if (channelId) {
    // Resolve by ID - safe, unambiguous
    channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error(`Channel with ID ${channelId} not found or not a text channel`);
  } else {
    // Fallback: resolve by name - reject if ambiguous
    const category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === categoryName
    );
    if (!category) throw new Error(`Category "${categoryName}" not found`);
    const matches = guild.channels.cache.filter(
      c => c.type === ChannelType.GuildText && c.parentId === category.id && c.name === channelName
    );
    if (matches.size === 0) throw new Error(`Channel "#${channelName}" not found in "${categoryName}"`);
    if (matches.size > 1) throw new Error(`Multiple channels named "#${channelName}" - use the channel picker to select which one.`);
    channel = matches.first();
  }

  // Snapshot everything we need to recreate
  const snapshot = {
    name: channel.name,
    categoryName,
    channelId: channel.id,
    topic: channel.topic || undefined,
    nsfw: channel.nsfw,
    rateLimitPerUser: channel.rateLimitPerUser || 0,
    position: channel.position,
    parentId: channel.parentId,
    permissionOverwrites: channel.permissionOverwrites.cache.map(po => ({
      id: po.id,
      type: po.type,
      allow: po.allow.bitfield.toString(),
      deny: po.deny.bitfield.toString(),
    })),
  };

  // Snapshot webhooks (name only - URLs change on recreate)
  const channelWebhooks = await channel.fetchWebhooks();
  const webhookSnapshots = channelWebhooks
    .filter(wh => wh.type === 1) // Only Incoming webhooks - Channel Follower and Application can't be recreated
    .map(wh => ({ name: wh.name }));
  snapshot.webhooks = webhookSnapshots;

  // Persist snapshot to /config before deleting - recovery safety net
  const recoveryDir = path.join(path.dirname(CONFIG_PATH), 'recovery');
  if (!fs.existsSync(recoveryDir)) fs.mkdirSync(recoveryDir, { recursive: true });
  const safeName = channel.name.replace(/[^\w-]/g, '_');
  const recoveryPath = path.join(recoveryDir, `purge-all-${safeName}-${Date.now()}.json`);
  fs.writeFileSync(recoveryPath, JSON.stringify(snapshot, null, 2));
  fixOwnership(recoveryPath);
  log('INFO', `Purge All: snapshot saved to ${recoveryPath}`);

  log('INFO', `Purge All: deleting #${snapshot.name} in "${categoryName}" (${channelWebhooks.size} webhooks, ${snapshot.permissionOverwrites.length} permission overwrites)`);

  // Delete the channel - point of no return
  await channel.delete(`PurgeBot Purge All - recreating #${snapshot.name}`);

  // Recreate with identical settings (retry up to 3 times - if this fails the channel is gone)
  const createOpts = {
    name: snapshot.name,
    type: ChannelType.GuildText,
    topic: snapshot.topic,
    nsfw: snapshot.nsfw,
    rateLimitPerUser: snapshot.rateLimitPerUser,
    position: snapshot.position,
    parent: snapshot.parentId,
    permissionOverwrites: snapshot.permissionOverwrites.map(po => ({
      id: po.id,
      type: po.type,
      allow: new PermissionsBitField(BigInt(po.allow)),
      deny: new PermissionsBitField(BigInt(po.deny)),
    })),
    reason: `PurgeBot Purge All - recreated #${snapshot.name}`,
  };
  let newChannel;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      newChannel = await guild.channels.create(createOpts);
      break;
    } catch (createErr) {
      log('ERROR', `Purge All: create attempt ${attempt}/3 failed: ${createErr.message}`);
      if (attempt === 3) {
        log('ERROR', `Purge All: CHANNEL LOST - failed to recreate #${snapshot.name}. Recovery file: ${recoveryPath}`);
        throw new Error(`Channel deleted but recreation failed after 3 attempts: ${createErr.message}. Recovery file saved - use Recover in Settings to restore.`);
      }
      await sleep(1000 * attempt);
    }
  }

  // Recreate webhooks
  const newWebhooks = [];
  const failedWebhooks = [];
  for (const ws of webhookSnapshots) {
    try {
      const wh = await newChannel.createWebhook({ name: ws.name, reason: 'PurgeBot Purge All - recreated webhook' });
      newWebhooks.push({ name: wh.name, url: wh.url });
    } catch (err) {
      log('WARN', `Purge All: failed to recreate webhook "${ws.name}": ${err.message}`);
      failedWebhooks.push({ name: ws.name, error: err.message });
    }
  }

  // Clean up recovery file on full success
  if (failedWebhooks.length === 0) {
    try { fs.unlinkSync(recoveryPath); } catch {}
  } else {
    log('WARN', `Purge All: ${failedWebhooks.length} webhook(s) failed - recovery file kept: ${recoveryPath}`);
  }

  log('INFO', `Purge All: recreated #${newChannel.name} (id: ${newChannel.id}) with ${newWebhooks.length} webhook(s), ${failedWebhooks.length} failed`);
  audit.record('discord.purge_all_recreate', {
    actor: { kind: 'bot' },
    details: {
      category: categoryName,
      oldChannelId: snapshot.id,
      newChannelId: newChannel.id,
      channelName: snapshot.name,
      webhooks: newWebhooks.length,
      webhooksFailed: failedWebhooks.length,
      recoveryFile: path.basename(recoveryPath),
    },
  });

  return {
    channelName: newChannel.name,
    channelId: newChannel.id,
    webhooks: [...newWebhooks, ...failedWebhooks.map(f => ({ name: f.name, url: null, error: f.error }))],
  };
}

// --- Channel ID resolver (for Purge All disambiguation) ---

async function resolveChannels(categoryName) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error('Guild not available');
  await guild.channels.fetch();

  const category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === categoryName
  );
  if (!category) throw new Error(`Category "${categoryName}" not found`);

  const channels = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText && c.parentId === category.id)
    .map(c => ({ id: c.id, name: c.name, position: c.position, topic: c.topic || '', parentId: category.id }))
    .sort((a, b) => a.position - b.position);
  return channels;
}

// --- Purge All Recovery ---

const RECOVERY_DIR = path.join(path.dirname(CONFIG_PATH), 'recovery');

function listRecoveryFiles() {
  if (!fs.existsSync(RECOVERY_DIR)) return [];
  return fs.readdirSync(RECOVERY_DIR)
    .filter(f => f.startsWith('purge-all-') && f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(RECOVERY_DIR, f), 'utf8'));
        return { file: f, name: data.name, category: data.categoryName, webhooks: (data.webhooks || []).length, timestamp: parseInt(f.match(/-(\d+)\.json$/)?.[1] || '0') };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp);
}

async function recoverChannel(filename) {
  const filePath = path.join(RECOVERY_DIR, filename);
  if (!fs.existsSync(filePath)) throw new Error('Recovery file not found');

  const snapshot = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error('Guild not available');
  await guild.channels.fetch();

  // Check the channel doesn't already exist (it was already recovered)
  const existing = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.parentId === snapshot.parentId && c.name === snapshot.name
  );
  if (existing) throw new Error(`Channel #${snapshot.name} already exists in this category - it may have been recovered already.`);

  const newChannel = await guild.channels.create({
    name: snapshot.name,
    type: ChannelType.GuildText,
    topic: snapshot.topic,
    nsfw: snapshot.nsfw,
    rateLimitPerUser: snapshot.rateLimitPerUser || 0,
    position: snapshot.position,
    parent: snapshot.parentId,
    permissionOverwrites: (snapshot.permissionOverwrites || []).map(po => ({
      id: po.id,
      type: po.type,
      allow: new PermissionsBitField(BigInt(po.allow)),
      deny: new PermissionsBitField(BigInt(po.deny)),
    })),
    reason: `PurgeBot Purge All - recovered #${snapshot.name} from snapshot`,
  });

  const newWebhooks = [];
  for (const ws of (snapshot.webhooks || [])) {
    try {
      const wh = await newChannel.createWebhook({ name: ws.name, reason: 'PurgeBot Purge All - recovered webhook' });
      newWebhooks.push({ name: wh.name, url: wh.url });
    } catch (err) {
      newWebhooks.push({ name: ws.name, url: null, error: err.message });
    }
  }

  // Clean up recovery file only on full success (channel + all webhooks)
  const failedWh = newWebhooks.filter(w => !w.url);
  if (failedWh.length === 0) {
    try { fs.unlinkSync(filePath); } catch {}
  } else {
    log('WARN', `Purge All recovery: ${failedWh.length} webhook(s) failed - keeping recovery file: ${filePath}`);
  }
  log('INFO', `Purge All: recovered #${newChannel.name} (id: ${newChannel.id}) from ${filename}`);

  return { channelName: newChannel.name, channelId: newChannel.id, webhooks: newWebhooks };
}

// --- Module Exports (for UI server) ---

function isCleanupRunning() { return cleanupRunning; }
function isCleanupCancelling() { return cleanupCancelled; }
function getCleanupStartTime() { return cleanupStartTime; }
function cancelCleanup() {
  if (!cleanupRunning) return false;
  cleanupCancelled = true;
  log('INFO', 'Cleanup cancellation requested');
  return true;
}

// --- Channel/Category Sorting ---

async function sortServer({ mode = 'both', dryRun = false, skipChannelsInCategories = [], includeVoice = false, pinnedPositions = {} } = {}) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error(`Guild ${GUILD_ID} not found`);
  await guild.channels.fetch();

  const results = { categories: [], channels: [], totalMoves: 0 };
  // skipChannelsInCategories only affects channel sorting within categories,
  // NOT category reordering (which always sorts all categories alphabetically).
  const skipSet = new Set(skipChannelsInCategories);

  // Sort categories - pinned categories go to their designated position,
  // remaining categories sorted alphabetically around them.
  if (mode === 'categories' || mode === 'both') {
    // Optionally exclude voice-only categories (no text channels)
    const hasTextChannels = (cat) => guild.channels.cache
      .some(c => c.parentId === cat.id && c.type === ChannelType.GuildText);
    const catFilter = (c) => c.type === ChannelType.GuildCategory && (includeVoice || hasTextChannels(c));

    const allCats = [...guild.channels.cache.filter(catFilter).values()];

    // Separate pinned from unpinned, sort unpinned alphabetically
    const pinned = []; // { cat, pos }
    const unpinned = [];
    for (const cat of allCats) {
      const raw = pinnedPositions[cat.name];
      if (raw !== undefined && raw !== null && raw !== '') {
        const pos = parseInt(raw, 10);
        if (!isNaN(pos)) {
          pinned.push({ cat, pos });
          continue;
        }
      }
      unpinned.push(cat);
    }
    unpinned.sort((a, b) => a.name.localeCompare(b.name));

    // Build final order: place pinned at their positions, fill gaps with unpinned
    const total = allCats.length;
    const sorted = new Array(total);
    const lastPinned = pinned.filter(p => p.pos === -1);
    const fixedPinned = pinned.filter(p => p.pos >= 0).sort((a, b) => a.pos - b.pos);

    // Place fixed-position pins - find nearest open slot on conflict
    const findSlot = (start, dir = 1) => {
      for (let j = start; j >= 0 && j < total; j += dir) {
        if (!sorted[j]) return j;
      }
      // Fallback: search opposite direction
      for (let j = start; j >= 0 && j < total; j -= dir) {
        if (!sorted[j]) return j;
      }
      return -1;
    };

    for (const p of fixedPinned) {
      const idx = Math.min(p.pos, total - 1);
      const slot = findSlot(idx, 1);
      if (slot >= 0) sorted[slot] = p.cat;
    }

    // Fill remaining slots with unpinned (alphabetical), leaving room for lastPinned at end
    let ui = 0;
    for (let i = 0; i < total; i++) {
      if (!sorted[i] && ui < unpinned.length) {
        sorted[i] = unpinned[ui++];
      }
    }

    // Place "last" pinned in remaining empty slots at end
    for (const p of lastPinned) {
      const slot = findSlot(total - 1, -1);
      if (slot >= 0) sorted[slot] = p.cat;
    }

    // Safety: filter out any undefined entries (shouldn't happen, but defensive)
    const finalSorted = sorted.filter(Boolean);
    const currentOrder = [...allCats].sort((a, b) => a.rawPosition - b.rawPosition);

    for (let i = 0; i < finalSorted.length; i++) {
      if (finalSorted[i].id !== currentOrder[i]?.id) {
        results.categories.push({ name: finalSorted[i].name, from: currentOrder.findIndex(c => c.id === finalSorted[i].id), to: i });
        results.totalMoves++;
      }
    }
    if (!dryRun && results.categories.length > 0) {
      let sortErrors = 0;
      for (let i = 0; i < finalSorted.length; i++) {
        await finalSorted[i].setPosition(i).catch(err => {
          sortErrors++;
          log('WARN', `Failed to set position for category "${finalSorted[i].name}": ${err.message}`);
        });
      }
      log('INFO', `Sorted ${results.categories.length} categories${sortErrors > 0 ? ` (${sortErrors} errors)` : ''}`);
    }
  }

  // Sort channels within each included category
  if (mode === 'channels' || mode === 'both') {
    const categories = [...guild.channels.cache
      .filter(c => c.type === ChannelType.GuildCategory)
      .values()]
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const category of categories) {
      if (skipSet.has(category.name)) continue;

      const sorted = [...guild.channels.cache
        .filter(c => c.parentId === category.id && c.type === ChannelType.GuildText)
        .values()]
        .sort((a, b) => a.name.localeCompare(b.name));

      const currentOrder = [...guild.channels.cache
        .filter(c => c.parentId === category.id && c.type === ChannelType.GuildText)
        .values()]
        .sort((a, b) => a.rawPosition - b.rawPosition);

      const moves = [];
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].id !== currentOrder[i]?.id) {
          moves.push({ name: sorted[i].name, from: currentOrder.findIndex(c => c.id === sorted[i].id), to: i });
        }
      }

      if (moves.length > 0) {
        results.channels.push({ category: category.name, moves });
        results.totalMoves += moves.length;

        if (!dryRun) {
          let chErrors = 0;
          for (let i = 0; i < sorted.length; i++) {
            await sorted[i].setPosition(i, { relative: false }).catch(err => {
              chErrors++;
              log('WARN', `Failed to set position for #${sorted[i].name}: ${err.message}`);
            });
          }
          log('INFO', `Sorted ${moves.length} channels in "${category.name}"${chErrors > 0 ? ` (${chErrors} errors)` : ''}`);
        }
      }
    }
  }

  const action = dryRun ? 'would move' : 'moved';
  log('INFO', `Sort ${dryRun ? 'dry-run' : 'complete'}: ${results.totalMoves} ${action} (mode: ${mode})`);
  audit.record('discord.sort_run', {
    actor: { kind: 'bot' },
    details: {
      mode,
      dryRun,
      totalMoves: results.totalMoves,
      categoryMoves: results.categories.length,
      channelGroups: results.channels.length,
    },
  });
  return results;
}

module.exports = {
  version, config, client, logEmitter, loadConfig, runCleanup, syncConfig, setupCron,
  CONFIG_HEADER, CONFIG_PATH, STATS_PATH, fixOwnership, configForDisk, log, LOG_DIR,
  isCleanupRunning, isCleanupCancelling, getCleanupStartTime, cancelCleanup, writeHeartbeat, getConfiguredChannels,
  getRetention, getRetentionSource, formatRetention, fetchGuildWebhooks, purgeAllChannel, listRecoveryFiles, recoverChannel, resolveChannels,
  sortServer, isSortRunning: () => sortRunning, checkPermissions,
  isAllowedDiscordWebhookUrl, isAllowedGotifyUrl,
  CRED_MASK, maskCredential, resolveMaskedCredential, maskedConfigSnapshot,
};

function checkPermissions() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error(`Guild ${GUILD_ID} not found`);
  const me = guild.members.me;
  if (!me) throw new Error('Bot member not available');

  const perms = me.permissions;
  const check = (flag) => perms.has(flag);

  const permissions = {
    ViewChannel: check(PermissionsBitField.Flags.ViewChannel),
    ReadMessageHistory: check(PermissionsBitField.Flags.ReadMessageHistory),
    ManageMessages: check(PermissionsBitField.Flags.ManageMessages),
    ManageChannels: check(PermissionsBitField.Flags.ManageChannels),
    ManageWebhooks: check(PermissionsBitField.Flags.ManageWebhooks),
    ManageRoles: check(PermissionsBitField.Flags.ManageRoles),
    Administrator: check(PermissionsBitField.Flags.Administrator),
  };

  const features = {
    cleanup: permissions.ViewChannel && permissions.ReadMessageHistory && permissions.ManageMessages,
    sync: permissions.ViewChannel,
    purgeAll: permissions.ViewChannel && permissions.ManageChannels && permissions.ManageWebhooks && permissions.ManageRoles,
    webhookDiscovery: permissions.ViewChannel && permissions.ManageWebhooks,
    sorting: permissions.ViewChannel && permissions.ManageChannels,
  };

  return { permissions, features, isAdmin: permissions.Administrator };
}

// --- Main ---

loadConfig();
rotateLogs(config.logging.maxDays);

// Audit log lives next to the runtime log + carries the same UID/GID so
// the user can read both with the same permissions. Rotate at startup so
// the file count stays bounded across container restarts.
audit.configure({
  logDir: LOG_DIR,
  fixOwnership,
  onError: (msg) => log('WARN', msg),
});
audit.rotate(config.logging.maxDays);

// Start UI server (available before Discord login)
if (!process.argv.includes('--sync') && !process.argv.includes('--now')) {
  const { startServer } = require('./ui/server');
  httpServer = startServer();
}

log('INFO', 'PurgeBot connecting to Discord...');
client.login(DISCORD_TOKEN);
