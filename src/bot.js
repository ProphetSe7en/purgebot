const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
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
    parsed.timezone = parsed.timezone || 'Europe/Oslo';
    parsed.discord = parsed.discord || {};
    // (N12) Validate discord config values
    parsed.discord.maxMessagesPerChannel = Math.max(1, Math.floor(parsed.discord.maxMessagesPerChannel ?? 500));
    parsed.discord.maxOldDeletesPerChannel = Math.max(0, Math.floor(parsed.discord.maxOldDeletesPerChannel ?? 50));
    parsed.discord.delayBetweenChannels = Math.max(0, Math.floor(parsed.discord.delayBetweenChannels ?? 2000));
    parsed.discord.skipPinned = parsed.discord.skipPinned ?? true;
    parsed.logging = parsed.logging || {};
    parsed.logging.maxDays = Math.max(1, Math.floor(parsed.logging.maxDays ?? 30));
    parsed.webhooks = parsed.webhooks || {};
    parsed.webhooks.cleanupColor = parsed.webhooks.cleanupColor || '#238636';
    parsed.webhooks.infoColor = parsed.webhooks.infoColor || '#f39c12';
    parsed.scheduleEnabled = parsed.scheduleEnabled !== false;
    parsed.display = parsed.display || {};
    parsed.display.timeFormat = parsed.display.timeFormat || '24h';
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

function getLogFile() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(LOG_DIR, `purgebot-${date}.log`);
}

// Track ownership: only mkdir/chown once per log file (resets on date rollover)
let lastLogFileOwned = '';

function log(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
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
# Schedule and timezone changes via the Web UI take effect immediately.
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
  const { _discoveryComplete, ...rest } = config;
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
    footer: { text: `${channelResults.length} channels • ${totalPurged} messages ${isDryRun ? 'would be purged' : 'purged'}` },
    timestamp: new Date().toISOString(),
  };
}

// --- Auto-Discovery ---

// Discovers new categories/channels and adds them to config before cleanup.
// New categories are always disabled. New channels inherit category default.
// Only adds — never removes. Use --sync for full reconciliation.
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

  if (changes > 0 || isFirstDiscovery) {
    config._discoveryComplete = true;
    const yamlStr = yaml.dump(configForDisk(), { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false });
    const tmpPath = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, CONFIG_HEADER + yamlStr, 'utf8');
    fs.renameSync(tmpPath, CONFIG_PATH);
    fixOwnership(CONFIG_PATH);
    if (changes > 0) log('INFO', `Auto-discovery: ${changes} new channels/categories added to config`);

    if (!isFirstDiscovery && discoveries.length > 0) {
      await sendDiscoveryNotification(discoveries);
    }
  }
}

async function sendDiscoveryNotification(discoveries) {
  const webhookUrl = config.webhooks.info;
  if (!webhookUrl) return;

  const lines = [];
  const newCategories = discoveries.filter(d => d.type === 'category');
  const newChannels = discoveries.filter(d => d.type === 'channel');

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

  let description = lines.join('\n');
  if (description.length > 4000) {
    description = description.substring(0, 3990) + '\n... (truncated)';
  }

  const infoColor = parseInt((config.webhooks?.infoColor || '#f39c12').replace('#', ''), 16) || 0xf39c12;
  const embed = {
    title: 'Channel Auto-Discovery',
    description,
    color: infoColor,
    footer: { text: `${discoveries.length} change${discoveries.length !== 1 ? 's' : ''} detected` },
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

// --- Stats Persistence ---

const STATS_PATH = path.join(path.dirname(CONFIG_PATH), 'stats.json');

function persistStats(lastRun) {
  try {
    let data = { lastRun: null, history: [] };
    if (fs.existsSync(STATS_PATH)) {
      data = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    }
    data.lastRun = lastRun;
    if (!lastRun.dryRun) {
      data.lastLiveRun = lastRun;
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

async function runCleanup(options = {}) {
  const { forceDryRun = false, forceLive = false, categoryFilter = null, channelFilter = null, trigger = 'schedule' } = options;

  if (cleanupRunning) {
    log('WARN', 'Cleanup already running, skipping');
    return;
  }
  cleanupRunning = true;
  cleanupCancelled = false;

  const startTime = Date.now();

  try {
    // (#10) Hot-reload config — don't crash on parse errors
    loadConfig(false);
    const effectiveDryRun = forceLive ? false : (config.dryRun || forceDryRun);
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

    const embeds = [];
    const categoryStats = {};

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

        const retention = getRetention(catName, chanName);
        const retentionSource = getRetentionSource(catName, chanName);

        // Skip if never-delete
        if (retention === -1) {
          channelResults.push({ name: chanName, skipped: true });
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
              const batch = bulkDeletable.slice(i, i + 100);
              if (batch.length === 1) {
                await batch[0].delete();
                deleted++;
              } else {
                const result = await channel.bulkDelete(batch, true);
                deleted += result.size;
              }
            }

            // (#1) Delete old messages individually (>14 days, can't bulk delete)
            const maxOld = config.discord.maxOldDeletesPerChannel;
            const oldToDelete = oldDeletable.slice(0, maxOld);
            for (const msg of oldToDelete) {
              if (cleanupCancelled) break;
              try {
                await msg.delete();
                deleted++;
              } catch (delErr) {
                log('WARN', `${catName}/#${chanName}: failed to delete message ${msg.id}: ${delErr.message}`);
              }
              await sleep(1200); // Rate limit: ~1 delete per second
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

        await sleep(config.discord.delayBetweenChannels);
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

      // Build embed only for categories with activity (purged messages or errors)
      const hasPurged = channelResults.some(ch => ch.purged > 0);
      if (hasPurged || catErrors) {
        embeds.push(buildCategoryEmbed(catName, channelResults, catErrors, effectiveDryRun));
      }
    }

    // (#5) Summary log — correct count in both modes
    const cancelled = cleanupCancelled;
    const action = effectiveDryRun ? 'would delete' : 'deleted';
    const suffix = cancelled ? ' (cancelled)' : '';
    log('INFO', `Cleanup ${cancelled ? 'cancelled' : 'complete'}: ${totalProcessed} channels processed, ${totalPurged} messages ${action}, ${totalSkipped} skipped, ${totalErrors} errors`);

    // Send webhook only when there's something to report
    if (embeds.length > 0) {
      await sendWebhook(embeds);
    }

    // Persist stats to stats.json
    const duration = Date.now() - startTime;
    const runStats = {
      timestamp: new Date().toISOString(),
      totalProcessed, totalPurged, totalErrors,
      dryRun: effectiveDryRun, duration, trigger,
      cancelled,
      categories: categoryStats,
    };
    persistStats(runStats);

    // Notify UI via SSE that cleanup is complete
    logEmitter.emit('cleanup-complete', runStats);

    // (#6) Update heartbeat after successful run
    writeHeartbeat();
  } finally {
    cleanupRunning = false;
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

function setupCron() {
  if (cronJob) { cronJob.stop(); cronJob = null; }

  if (!config.scheduleEnabled) {
    log('INFO', 'Schedule disabled — cleanup runs manually only');
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

  log('INFO', `Cron scheduled: "${schedule}" (${config.timezone})`);
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

// --- Module Exports (for UI server) ---

function isCleanupRunning() { return cleanupRunning; }
function cancelCleanup() {
  if (!cleanupRunning) return false;
  cleanupCancelled = true;
  log('INFO', 'Cleanup cancellation requested');
  return true;
}

module.exports = {
  config, client, logEmitter, loadConfig, runCleanup, syncConfig, setupCron,
  CONFIG_HEADER, CONFIG_PATH, STATS_PATH, fixOwnership, configForDisk, log, LOG_DIR,
  isCleanupRunning, cancelCleanup, writeHeartbeat, getConfiguredChannels,
  getRetention, getRetentionSource, formatRetention,
};

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
