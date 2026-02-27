const express = require('express');
const router = express.Router();
const bot = require('../../bot');

// Guard: reject if cleanup or sync already running
let syncRunning = false;

// POST /api/cleanup/run — trigger cleanup (optional: {category} for single-category run)
router.post('/run', (req, res) => {
  if (!bot.client.isReady()) {
    return res.status(503).json({ error: 'Discord not connected' });
  }
  if (bot.isCleanupRunning() || syncRunning) {
    return res.status(409).json({ error: 'Cleanup or sync already running' });
  }

  const { category, channel } = req.body || {};
  bot.runCleanup({ categoryFilter: category || null, channelFilter: channel || null })
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
  bot.runCleanup({ forceDryRun: true, categoryFilter: category || null, channelFilter: channel || null })
    .catch(err => bot.log('ERROR', `UI-triggered dry-run failed: ${err.message}`));
  const label = channel ? `#${channel}` : (category || 'all');
  res.json({ ok: true, message: `Dry-run started for ${label}` });
});

module.exports = router;
