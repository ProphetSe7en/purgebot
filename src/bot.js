const { Client, GatewayIntentBits, ChannelType, PermissionsBitField } = require('discord.js');
const yaml = require('js-yaml');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// --- Log Event Emitter (for SSE streaming) ---
const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50); // Allow many SSE clients

// Set umask early — ensures correct permissions even via docker exec (which skips entrypoint)
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

    // Warn about deprecated overrides: sections (#8)
    for (const [catName, cat] of Object.entries(parsed.categories)) {
      if (cat.overrides) {
        log('WARN', `Category "${catName}" uses deprecated 'overrides:' section — run --sync to migrate to inline format`);
      }
    }

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
      console.error('Mount a config volume with config.yaml — see config.yaml.sample for reference');
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

// _channels entries can be a plain string ("general") or a mapping ({"general": 3})
function getChannelOverride(cat, channelName) {
  if (!cat._channels || !Array.isArray(cat._channels)) return undefined;
  for (const entry of cat._channels) {
    if (typeof entry === 'object' && entry !== null && entry[channelName] !== undefined) {
      return entry[channelName];
    }
  }
  return undefined;
}

// --- Retention Resolution ---

function isEnabled(categoryName) {
  const cat = config.categories[categoryName];
  if (!cat) return false;
  return cat.enabled === true;
}

// (#2, #19) Validate retention value — must be integer, >= -1
function validateRetention(value, context) {
  if (typeof value !== 'number' || !Number.isInteger(value) || (value < -1)) {
    log('WARN', `Invalid retention value "${value}" for ${context}, using globalDefault (${config.globalDefault})`);
    return config.globalDefault;
  }
  return value;
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

const CONFIG_HEADER = `# PurgeBot — Configuration
#
# Retention hierarchy (first match wins):
#   1. Inline override on channel  — per-channel retention
#   2. default                     — category-wide default
#   3. globalDefault               — fallback for categories without a default
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
# Config is re-read before each cleanup run — no restart needed after editing.
# Schedule changes via the Web UI take effect immediately.
# Timezone is set via the TZ environment variable in Docker.
#
# deleteOld: true  — delete all messages older than retention (default)
# deleteOld: false — only bulk-delete messages up to 14 days old (faster)
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

// --- Webhook Notification ---

async function sendWebhook(embeds) {
  const webhookUrl = config.webhooks.cleanup;
  if (!webhookUrl) return;

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
        log('WARN', `Webhook response: ${res.status} — ${body}`);
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
  let description = `Deleted **${runStats.totalPurged}** messages from **${runStats.totalProcessed}** channels (${catCount} categories) in **${formatDuration(runStats.duration)}**`;
  if (runStats.totalErrors > 0) {
    description += `\n⚠ ${runStats.totalErrors} error${runStats.totalErrors !== 1 ? 's' : ''}`;
  }
  if (runStats.cancelled) {
    description += `\n⚠ Cancelled (partial run)`;
  }

  // Discord notification
  const webhookUrl = config.webhooks.info;
  if (webhookUrl) {
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
        log('WARN', `Summary webhook response: ${res.status} — ${body}`);
      }
    } catch (err) {
      log('ERROR', `Summary webhook failed: ${err.message}`);
    }
  }

  // Gotify notification — combined summary with per-category breakdown
  let gotifyMsg = description;
  const cats = runStats.categories || {};
  const activeCats = Object.entries(cats).filter(([, s]) => s.purged > 0 || s.errors > 0);
  if (activeCats.length > 0) {
    gotifyMsg += '\n';
    for (const [catName, stats] of activeCats) {
      let line = `- **${catName}:** ${stats.purged} purged`;
      if (stats.errors > 0) line += `, ${stats.errors} error${stats.errors !== 1 ? 's' : ''}`;
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

// (#14) Truncate embed description to stay within Discord's 4096 char limit
function buildCategoryEmbed(catName, channelResults, hasErrors, isDryRun) {
  const prefix = isDryRun ? 'Dry Run — ' : '';
  const lines = [];

  for (const ch of channelResults) {
    // Only show channels with activity or errors
    if (ch.error) {
      lines.push(`#${ch.name} — ❌ ${ch.error}`);
    } else if (ch.purged > 0) {
      const source = ch.retentionSource === 'override' ? ' (override)' : '';
      lines.push(`#${ch.name} — ${ch.retention}d${source} — **${ch.purged} purged**`);
    }
  }

  const totalPurged = channelResults.reduce((sum, ch) => sum + (ch.purged || 0), 0);
  const successColor = parseInt((config.webhooks?.cleanupColor || '#238636').replace('#', ''), 16) || 0x238636;
  let color = isDryRun ? 0x3498db : successColor;
  if (hasErrors) color = 0xe74c3c;
  if (totalPurged === 0 && !hasErrors) color = 0x95a5a6;

  let description = lines.join('\n');
  if (description.length > 4000) {
    description = description.substring(0, 3990) + '\n... (truncated)';
  }

  return {
    title: `${prefix}Message Cleanup — ${catName}`,
    description,
    color,
    footer: { text: `${channelResults.length} channels • ${totalPurged} messages ${isDryRun ? 'would be purged' : 'purged'} · PurgeBot v${version} by ProphetSe7en` },
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

  // Don't notify on first auto-discovery run — only on subsequent changes
  const isFirstDiscovery = !config._discoveryComplete;
  let changes = 0;
  const discoveries = [];

  // --- Add new categories and channels ---
  for (const [catName, channels] of discoveredMap) {
    const sortedChannels = [...channels].sort();

    if (!config.categories[catName]) {
      config.categories[catName] = { enabled: false, default: config.globalDefault, _channels: sortedChannels };
      changes++;
      log('INFO', `Auto-discovered category "${catName}" (DISABLED) — ${channels.length} channels`);
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
        log('INFO', `Auto-discovered #${chanName} in "${catName}" (${formatRetention(effectiveRetention)} — ${source} default)`);
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
    lines.push(`**New category: ${cat.name}** — \`DISABLED\``);
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
      lines.push(`**${catName}** — #${ch.name} added`);
      lines.push(`Cleanup: ${formatRetention(ch.retention)} (${ch.source} default)${status}`);
    }
  }

  // Removed categories
  for (const cat of removedCategories) {
    lines.push(`**Removed category: ${cat.name}** — ${cat.channelCount} channel${cat.channelCount !== 1 ? 's' : ''} removed from config`);
  }

  // Group removed channels by category
  const removedByCategory = new Map();
  for (const ch of removedChannels) {
    if (!removedByCategory.has(ch.category)) removedByCategory.set(ch.category, []);
    removedByCategory.get(ch.category).push(ch);
  }

  for (const [catName, channels] of removedByCategory) {
    const names = channels.map(ch => `#${ch.name}`).join(', ');
    lines.push(`**${catName}** — ${names} removed (deleted from Discord)`);
  }

  let description = lines.join('\n');
  if (description.length > 4000) {
    description = description.substring(0, 3990) + '\n... (truncated)';
  }

  // Discord notification
  const webhookUrl = config.webhooks.info;
  if (webhookUrl) {
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
        log('WARN', `Info webhook response: ${res.status} — ${body}`);
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
    lines.push(`**Categories sorted** — ${results.categories.length} repositioned`);
    for (const cat of results.categories) {
      lines.push(`· ${cat.name}: position ${cat.from} → ${cat.to}`);
    }
  }

  // Channel moves per category
  for (const catGroup of results.channels) {
    lines.push(`\n**${catGroup.category}** — ${catGroup.moves.length} channel${catGroup.moves.length !== 1 ? 's' : ''} sorted`);
  }

  if (lines.length === 0) return;

  let description = lines.join('\n');
  if (description.length > 4000) {
    description = description.substring(0, 3990) + '\n... (truncated)';
  }

  // Discord notification — use info webhook
  const webhookUrl = config.webhooks.info;
  if (webhookUrl) {
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
        log('WARN', `Sort notification webhook response: ${res.status} — ${body}`);
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
      log('WARN', `Gotify notification failed: ${res.status} — ${body}`);
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

      // Prune stale entries — keep top 200 channels and top 100 categories
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
  const { forceDryRun = false, forceLive = false, categoryFilter = null, channelFilter = null, trigger = 'schedule' } = options;

  if (cleanupRunning) {
    log('WARN', 'Cleanup already running, skipping');
    return;
  }
  cleanupRunning = true;
  cleanupCancelled = false;
  cleanupStartTime = Date.now();

  const startTime = Date.now();
  let effectiveDryRun = forceDryRun;

  try {
    // (#10) Hot-reload config — don't crash on parse errors
    loadConfig(false);
    effectiveDryRun = forceLive ? false : (config.dryRun || forceDryRun);
    let filterLabel = categoryFilter ? ` [category: ${categoryFilter}]` : '';
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

    // Process each enabled category — only channels in _channels (allow-list)
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
      if (categoryFilter && catName !== categoryFilter) {
        continue;
      }

      const allowedChannels = getConfiguredChannels(catName);
      const cat = config.categories[catName];
      const deleteOld = cat.deleteOld !== false; // defaults to true
      const channelResults = [];
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

        const retention = getRetention(catName, chanName);
        const retentionSource = getRetentionSource(catName, chanName);

        // Skip if never-delete
        if (retention === -1) {
          const result = { name: chanName, skipped: true };
          channelResults.push(result);
          emitProgress({ category: catName, channel: result, totalProcessed, totalPurged, totalErrors, dryRun: effectiveDryRun });
          continue;
        }

        // Calculate cutoff date
        const now = new Date();
        const cutoff = new Date(now.getTime() - retention * 24 * 60 * 60 * 1000);
        const bulkDeleteLimit = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

        try {
          // (#1) Split into bulk-deletable (<14d) and old (>14d) messages
          let bulkDeletable = [];
          let oldDeletable = [];
          let lastId = undefined;
          let fetched = 0;
          const maxMessages = config.discord.maxMessagesPerChannel;

          while (fetched < maxMessages) {
            const batchSize = Math.min(100, maxMessages - fetched);
            const options = { limit: batchSize };
            if (lastId) options.before = lastId;

            const messages = await channel.messages.fetch(options);
            if (messages.size === 0) break;

            for (const [, msg] of messages) {
              // (N7) Skip pinned messages unless explicitly disabled
              if (msg.pinned && config.discord.skipPinned) continue;
              if (msg.createdAt < cutoff) {
                if (msg.createdAt > bulkDeleteLimit) {
                  bulkDeletable.push(msg);
                } else if (deleteOld) {
                  oldDeletable.push(msg);
                }
              }
            }

            lastId = messages.last().id;
            fetched += messages.size;
          }

          const totalDeletable = bulkDeletable.length + oldDeletable.length;
          let deleted = 0;

          if (totalDeletable === 0) {
            log('INFO', `  ${catName}/#${chanName}: 0 messages to delete (${fetched} scanned, retention=${retention}d)`);
          } else if (effectiveDryRun) {
            // (#5) Log correct count in dry-run mode — apply same maxOld cap as live mode
            const maxOld = config.discord.maxOldDeletesPerChannel;
            const cappedOld = oldDeletable.slice(0, maxOld).length;
            const wouldDelete = bulkDeletable.length + cappedOld;
            let detail = `${bulkDeletable.length} bulk`;
            if (cappedOld > 0) detail += ` + ${cappedOld} old (>14d)`;
            if (oldDeletable.length > maxOld) detail += `, ${oldDeletable.length - maxOld} old remaining`;
            const bulkOnly = !deleteOld ? ' (bulk only)' : '';
            log('INFO', `[DRY RUN] ${catName}/#${chanName}: would delete ${wouldDelete} messages (${detail}, retention=${retention}d)${bulkOnly}`);
            totalPurged += wouldDelete;
          } else {

            // Bulk delete messages within 14-day window
            // (#3) filterOld=true prevents error if messages aged past 14d between fetch and delete
            // (N2) Use return value for accurate count
            for (let i = 0; i < bulkDeletable.length; i += 100) {
              if (cleanupCancelled) break;
              const batch = bulkDeletable.slice(i, i + 100);
              if (batch.length === 1) {
                try {
                  await batch[0].delete();
                  deleted++;
                } catch (delErr) {
                  log('WARN', `${catName}/#${chanName}: failed to delete message ${batch[0].id}: ${delErr.message}`);
                }
              } else {
                const result = await channel.bulkDelete(batch, true);
                deleted += result.size;
              }
            }

            // (#1) Delete old messages individually (>14 days, can't bulk delete)
            const maxOld = config.discord.maxOldDeletesPerChannel;
            const oldToDelete = oldDeletable.slice(0, maxOld);
            if (oldToDelete.length > 0) {
              log('INFO', `  ${catName}/#${chanName}: deleting ${oldToDelete.length} old messages (>14d, ~${Math.ceil(oldToDelete.length * 1.2)}s)...`);
            }
            let oldDeletedCount = 0;
            for (const msg of oldToDelete) {
              if (cleanupCancelled) break;
              try {
                await msg.delete();
                deleted++;
                oldDeletedCount++;
                // Progress update every 10 messages
                if (oldDeletedCount % 10 === 0 && oldDeletedCount < oldToDelete.length) {
                  log('INFO', `  ${catName}/#${chanName}: ${oldDeletedCount}/${oldToDelete.length} old messages deleted...`);
                }
              } catch (delErr) {
                log('WARN', `${catName}/#${chanName}: failed to delete message ${msg.id}: ${delErr.message}`);
              }
              await sleep(config.discord.delayBetweenDeletes);
            }
            if (oldDeletable.length > maxOld) {
              log('WARN', `${catName}/#${chanName}: ${oldDeletable.length - maxOld} old messages remain (capped at ${maxOld}/run)`);
            }

            log('INFO', `${catName}/#${chanName}: deleted ${deleted} messages (retention=${retention}d)`);
            totalPurged += deleted;
          }

          // (N4) Report actual count in live mode, capped count in dry-run
          const maxOldForCount = config.discord.maxOldDeletesPerChannel;
          const cappedTotal = bulkDeletable.length + Math.min(oldDeletable.length, maxOldForCount);
          const purgedCount = effectiveDryRun ? cappedTotal : deleted;
          channelResults.push({ name: chanName, retention, retentionSource, purged: purgedCount });
        } catch (err) {
          log('ERROR', `${catName}/#${chanName}: ${err.message}`);
          channelResults.push({ name: chanName, retention, retentionSource, purged: 0, error: err.message });
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
      categoryStats[catName] = {
        processed: channelResults.length,
        purged: catPurged,
        errors: catErrors_count,
        channels: channelResults,
      };

      // Send per-category webhook immediately (live runs only)
      const hasPurged = channelResults.some(ch => ch.purged > 0);
      if (!effectiveDryRun && (hasPurged || catErrors)) {
        const embed = buildCategoryEmbed(catName, channelResults, catErrors, effectiveDryRun);
        await sendWebhook([embed]);
      }

      // Checkpoint stats after each category for crash recovery (only updates lastRun/lastLiveRun)
      const partialDuration = Date.now() - startTime;
      const partialRunStats = {
        timestamp: new Date().toISOString(),
        totalProcessed, totalPurged, totalErrors,
        dryRun: effectiveDryRun, duration: partialDuration, trigger,
        cancelled: cleanupCancelled,
        categories: categoryStats,
      };
      persistStats(partialRunStats, { partial: true });
    }

    // (#5) Summary log — correct count in both modes
    const cancelled = cleanupCancelled;
    const action = effectiveDryRun ? 'would delete' : 'deleted';
    log('INFO', `Cleanup ${cancelled ? 'cancelled' : 'complete'}: ${totalProcessed} channels processed, ${totalPurged} messages ${action}, ${totalSkipped} skipped, ${totalErrors} errors`);

    // Persist final stats to stats.json (overwrites incremental data with complete run)
    const duration = Date.now() - startTime;
    const runStats = {
      timestamp: new Date().toISOString(),
      totalProcessed, totalPurged, totalErrors,
      dryRun: effectiveDryRun, duration, trigger,
      cancelled,
      categories: categoryStats,
    };
    persistStats(runStats);

    // Send summary notification to info webhook (live runs only)
    await sendSummaryNotification(runStats);

    // Post-cleanup tasks (scheduled runs only, not manual, not dry-run)
    if (!effectiveDryRun && trigger === 'schedule') {

      // 1. Auto-sync — discover new/removed channels before sorting
      try {
        log('INFO', 'Post-cleanup sync: checking for channel changes...');
        await syncConfig({ exitOnError: false });
      } catch (err) {
        log('ERROR', `Post-cleanup sync failed: ${err.message}`);
      }

      // 2. Webhook discovery — log server webhooks
      if (config.webhookDiscoveryOnSchedule) {
        try {
          const whData = await fetchGuildWebhooks();
          log('INFO', `Webhook discovery: ${whData.total} webhook${whData.total !== 1 ? 's' : ''} across ${whData.categories.length} categor${whData.categories.length !== 1 ? 'ies' : 'y'}`);
        } catch (err) {
          log('ERROR', `Webhook discovery failed: ${err.message}`);
        }
      }

      // 3. Auto-sort — sort categories and channels
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
      // New category — add as disabled with channel list
      config.categories[catName] = { enabled: false, default: config.globalDefault, _channels: sortedChannels };
      changes++;
      changeDetails.push({ type: 'added', scope: 'category', category: catName, channels: sortedChannels });
      log('INFO', `+ Category "${catName}" (DISABLED, default: ${config.globalDefault}d) — ${channels.length} channels: ${channels.join(', ')}`);
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

      log('INFO', `  Category "${catName}" (${status}, default: ${cat.default ?? config.globalDefault}d) — ${channels.length} channels`);
    }
  }

  // Remove categories no longer on Discord
  for (const catName of Object.keys(config.categories)) {
    if (!discoveredMap.has(catName)) {
      const removedChannels = (config.categories[catName]._channels || []).map(ch => typeof ch === 'object' ? Object.keys(ch)[0] : ch);
      changeDetails.push({ type: 'removed', scope: 'category', category: catName, channels: removedChannels });
      delete config.categories[catName];
      changes++;
      log('WARN', `Category "${catName}": not found on Discord — removed from config`);
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
    log('INFO', 'No changes — config is up to date');
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
    if (hadCron) log('INFO', 'Schedule disabled — previous schedule stopped');
    else log('INFO', 'Schedule disabled — cleanup runs manually only');
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

  // (#6) Write initial heartbeat on startup
  writeHeartbeat();

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

// --- Webhook Discovery ---

async function fetchGuildWebhooks() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error('Guild not available — bot may still be connecting');

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
  if (!guild) throw new Error('Guild not available — bot may still be connecting');

  await guild.channels.fetch();

  let channel;
  if (channelId) {
    // Resolve by ID — safe, unambiguous
    channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error(`Channel with ID ${channelId} not found or not a text channel`);
  } else {
    // Fallback: resolve by name — reject if ambiguous
    const category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === categoryName
    );
    if (!category) throw new Error(`Category "${categoryName}" not found`);
    const matches = guild.channels.cache.filter(
      c => c.type === ChannelType.GuildText && c.parentId === category.id && c.name === channelName
    );
    if (matches.size === 0) throw new Error(`Channel "#${channelName}" not found in "${categoryName}"`);
    if (matches.size > 1) throw new Error(`Multiple channels named "#${channelName}" — use the channel picker to select which one.`);
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

  // Snapshot webhooks (name only — URLs change on recreate)
  const channelWebhooks = await channel.fetchWebhooks();
  const webhookSnapshots = channelWebhooks
    .filter(wh => wh.type === 1) // Only Incoming webhooks — Channel Follower and Application can't be recreated
    .map(wh => ({ name: wh.name }));
  snapshot.webhooks = webhookSnapshots;

  // Persist snapshot to /config before deleting — recovery safety net
  const recoveryDir = path.join(path.dirname(CONFIG_PATH), 'recovery');
  if (!fs.existsSync(recoveryDir)) fs.mkdirSync(recoveryDir, { recursive: true });
  const safeName = channel.name.replace(/[^\w-]/g, '_');
  const recoveryPath = path.join(recoveryDir, `purge-all-${safeName}-${Date.now()}.json`);
  fs.writeFileSync(recoveryPath, JSON.stringify(snapshot, null, 2));
  fixOwnership(recoveryPath);
  log('INFO', `Purge All: snapshot saved to ${recoveryPath}`);

  log('INFO', `Purge All: deleting #${snapshot.name} in "${categoryName}" (${channelWebhooks.size} webhooks, ${snapshot.permissionOverwrites.length} permission overwrites)`);

  // Delete the channel — point of no return
  await channel.delete(`PurgeBot Purge All — recreating #${snapshot.name}`);

  // Recreate with identical settings (retry up to 3 times — if this fails the channel is gone)
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
    reason: `PurgeBot Purge All — recreated #${snapshot.name}`,
  };
  let newChannel;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      newChannel = await guild.channels.create(createOpts);
      break;
    } catch (createErr) {
      log('ERROR', `Purge All: create attempt ${attempt}/3 failed: ${createErr.message}`);
      if (attempt === 3) {
        log('ERROR', `Purge All: CHANNEL LOST — failed to recreate #${snapshot.name}. Recovery file: ${recoveryPath}`);
        throw new Error(`Channel deleted but recreation failed after 3 attempts: ${createErr.message}. Recovery file saved — use Recover in Settings to restore.`);
      }
      await sleep(1000 * attempt);
    }
  }

  // Recreate webhooks
  const newWebhooks = [];
  const failedWebhooks = [];
  for (const ws of webhookSnapshots) {
    try {
      const wh = await newChannel.createWebhook({ name: ws.name, reason: 'PurgeBot Purge All — recreated webhook' });
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
    log('WARN', `Purge All: ${failedWebhooks.length} webhook(s) failed — recovery file kept: ${recoveryPath}`);
  }

  log('INFO', `Purge All: recreated #${newChannel.name} (id: ${newChannel.id}) with ${newWebhooks.length} webhook(s), ${failedWebhooks.length} failed`);

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
  if (existing) throw new Error(`Channel #${snapshot.name} already exists in this category — it may have been recovered already.`);

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
    reason: `PurgeBot Purge All — recovered #${snapshot.name} from snapshot`,
  });

  const newWebhooks = [];
  for (const ws of (snapshot.webhooks || [])) {
    try {
      const wh = await newChannel.createWebhook({ name: ws.name, reason: 'PurgeBot Purge All — recovered webhook' });
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
    log('WARN', `Purge All recovery: ${failedWh.length} webhook(s) failed — keeping recovery file: ${filePath}`);
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
  const guild = client.guilds.cache.first();
  if (!guild) throw new Error('Not connected to a guild');
  await guild.channels.fetch();

  const results = { categories: [], channels: [], totalMoves: 0 };
  // skipChannelsInCategories only affects channel sorting within categories,
  // NOT category reordering (which always sorts all categories alphabetically).
  const skipSet = new Set(skipChannelsInCategories);

  // Sort categories — pinned categories go to their designated position,
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

    // Place fixed-position pins — find nearest open slot on conflict
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
  return results;
}

module.exports = {
  version, config, client, logEmitter, loadConfig, runCleanup, syncConfig, setupCron,
  CONFIG_HEADER, CONFIG_PATH, STATS_PATH, fixOwnership, configForDisk, log, LOG_DIR,
  isCleanupRunning, isCleanupCancelling, getCleanupStartTime, cancelCleanup, writeHeartbeat, getConfiguredChannels,
  getRetention, getRetentionSource, formatRetention, fetchGuildWebhooks, purgeAllChannel, listRecoveryFiles, recoverChannel, resolveChannels,
  sortServer, isSortRunning: () => sortRunning, checkPermissions,
};

function checkPermissions() {
  const guild = client.guilds.cache.first();
  if (!guild) throw new Error('Not connected to a guild');
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

// Start UI server (available before Discord login)
if (!process.argv.includes('--sync') && !process.argv.includes('--now')) {
  const { startServer } = require('./ui/server');
  httpServer = startServer();
}

log('INFO', 'PurgeBot connecting to Discord...');
client.login(DISCORD_TOKEN);
