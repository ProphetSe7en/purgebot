const express = require('express');
const router = express.Router();
const bot = require('../../bot');

// Guard: reject if cleanup, sync, or purge-all already running
let syncRunning = false;
let purgeAllRunning = false;

// POST /api/cleanup/run — trigger cleanup (optional: {category} for single-category run)
router.post('/run', (req, res) => {
  if (!bot.client.isReady()) {
    return res.status(503).json({ error: 'Discord not connected' });
  }
  if (bot.isCleanupRunning() || syncRunning) {
    return res.status(409).json({ error: 'Cleanup or sync already running' });
  }

  const { category, channel } = req.body || {};
  bot.runCleanup({ forceLive: true, trigger: 'manual', categoryFilter: category || null, channelFilter: channel || null })
    .catch(err => bot.log('ERROR', `UI-triggered cleanup failed: ${err.message}`));
  const label = channel ? `#${channel}` : (category || 'all');
  res.json({ ok: true, message: `Cleanup started for ${label}` });
});

// POST /api/cleanup/sync — trigger channel sync (synchronous — returns result)
router.post('/sync', async (req, res) => {
  if (!bot.client.isReady()) {
    return res.status(503).json({ error: 'Discord not connected' });
  }
  if (bot.isCleanupRunning() || syncRunning) {
    return res.status(409).json({ error: 'Cleanup or sync already running' });
  }

  syncRunning = true;
  try {
    const result = await bot.syncConfig({ exitOnError: false });
    bot.log('INFO', 'UI-triggered sync complete');
    res.json({ ok: true, ...result });
  } catch (err) {
    bot.log('ERROR', `UI-triggered sync failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    syncRunning = false;
  }
});

// POST /api/cleanup/dryrun — force dry-run cleanup
router.post('/dryrun', (req, res) => {
  if (!bot.client.isReady()) {
    return res.status(503).json({ error: 'Discord not connected' });
  }
  if (bot.isCleanupRunning() || syncRunning) {
    return res.status(409).json({ error: 'Cleanup or sync already running' });
  }

  const { category, channel } = req.body || {};
  bot.runCleanup({ forceDryRun: true, trigger: 'manual', categoryFilter: category || null, channelFilter: channel || null })
    .catch(err => bot.log('ERROR', `UI-triggered dry-run failed: ${err.message}`));
  const label = channel ? `#${channel}` : (category || 'all');
  res.json({ ok: true, message: `Dry-run started for ${label}` });
});

// POST /api/cleanup/purge-all — delete and recreate a channel (manual only)
router.post('/purge-all', async (req, res) => {
  if (!bot.client.isReady()) {
    return res.status(503).json({ error: 'Discord not connected' });
  }
  if (bot.isCleanupRunning() || syncRunning || purgeAllRunning) {
    return res.status(409).json({ error: 'Another operation is already running' });
  }

  const { category, channel, channelId } = req.body || {};
  if (!category || !channel) {
    return res.status(400).json({ error: 'Both category and channel are required' });
  }

  purgeAllRunning = true;
  try {
    const result = await bot.purgeAllChannel(category, channel, channelId || null);
    bot.log('INFO', `UI-triggered Purge All complete for #${channel}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    bot.log('ERROR', `Purge All failed for #${channel}: ${err.message}`);
    // Discord error 50013 = Missing Permissions
    if (err.code === 50013) {
      return res.status(403).json({ error: 'Bot lacks Manage Channels or Manage Webhooks permission.' });
    }
    res.status(500).json({ error: err.message });
  } finally {
    purgeAllRunning = false;
  }
});

// GET /api/cleanup/resolve-channels?category=Name — return channels with IDs for a category
router.get('/resolve-channels', async (req, res) => {
  if (!bot.client.isReady()) {
    return res.status(503).json({ error: 'Discord not connected' });
  }
  const { category } = req.query;
  if (!category) {
    return res.status(400).json({ error: 'Category name is required' });
  }
  try {
    const channels = await bot.resolveChannels(category);
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cleanup/cancel — cancel a running cleanup
router.post('/cancel', (req, res) => {
  if (!bot.isCleanupRunning()) {
    return res.status(409).json({ error: 'No cleanup running' });
  }
  const cancelled = bot.cancelCleanup();
  res.json({ ok: cancelled });
});

// GET /api/cleanup/recovery — list recovery snapshots
router.get('/recovery', (req, res) => {
  res.json(bot.listRecoveryFiles());
});

// POST /api/cleanup/recover — recreate a channel from a recovery snapshot
router.post('/recover', async (req, res) => {
  if (!bot.client.isReady()) {
    return res.status(503).json({ error: 'Discord not connected' });
  }
  if (bot.isCleanupRunning() || syncRunning || purgeAllRunning) {
    return res.status(409).json({ error: 'Another operation is already running' });
  }

  const { file } = req.body || {};
  if (!file) {
    return res.status(400).json({ error: 'Recovery file name is required' });
  }
  // Sanitize: only allow expected filename pattern
  if (!/^purge-all-[\w-]+-\d+\.json$/.test(file)) {
    return res.status(400).json({ error: 'Invalid recovery file name' });
  }

  purgeAllRunning = true;
  try {
    const result = await bot.recoverChannel(file);
    bot.log('INFO', `UI-triggered recovery complete for #${result.channelName}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    bot.log('ERROR', `Recovery failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    purgeAllRunning = false;
  }
});

// POST /api/cleanup/sort — sort channels/categories alphabetically
let sortRunning = false;
router.post('/sort', async (req, res) => {
  if (!bot.client.isReady()) {
    return res.status(503).json({ error: 'Discord not connected' });
  }
  if (bot.isCleanupRunning() || syncRunning || sortRunning || bot.isSortRunning() || purgeAllRunning) {
    return res.status(409).json({ error: 'Another operation is running' });
  }

  const { mode = 'both', dryRun = false, skipCategories = [], includeVoice = false, pinnedPositions = {} } = req.body || {};
  if (!['categories', 'channels', 'both'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode — use categories, channels, or both' });
  }

  sortRunning = true;
  try {
    const results = await bot.sortServer({ mode, dryRun, skipChannelsInCategories: skipCategories, includeVoice, pinnedPositions });
    res.json(results);
  } catch (err) {
    bot.log('ERROR', `Sort failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    sortRunning = false;
  }
});

// GET /api/cleanup/permissions — check bot permissions
router.get('/permissions', (req, res) => {
  if (!bot.client.isReady()) {
    return res.status(503).json({ error: 'Discord not connected' });
  }
  try {
    res.json(bot.checkPermissions());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
