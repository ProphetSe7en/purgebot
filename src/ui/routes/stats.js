const express = require('express');
const fs = require('fs');
const router = express.Router();
const bot = require('../../bot');

// GET /api/stats — persisted cleanup stats
router.get('/', (req, res) => {
  try {
    if (fs.existsSync(bot.STATS_PATH)) {
      const data = JSON.parse(fs.readFileSync(bot.STATS_PATH, 'utf8'));
      res.json(data);
    } else {
      res.json({ lastRun: null, history: [] });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/status — live bot status
router.get('/status', (req, res) => {
  const cfg = bot.config;
  const connected = bot.client.isReady();
  const guild = connected ? bot.client.guilds.cache.get(process.env.GUILD_ID) : null;

  // Count categories
  const categories = Object.keys(cfg.categories || {});
  const enabledCount = categories.filter(c => cfg.categories[c].enabled).length;

  // Count channels across enabled categories
  let channelCount = 0;
  for (const catName of categories) {
    if (cfg.categories[catName].enabled && Array.isArray(cfg.categories[catName]._channels)) {
      channelCount += cfg.categories[catName]._channels.length;
    }
  }

  res.json({
    connected,
    guildName: guild?.name || null,
    cleanupRunning: bot.isCleanupRunning(),
    dryRun: cfg.dryRun ?? false,
    schedule: cfg.schedule || '0 2 * * *',
    timezone: cfg.timezone || 'Europe/Oslo',
    totalCategories: categories.length,
    enabledCategories: enabledCount,
    totalChannels: channelCount,
    globalDefault: cfg.globalDefault,
    uptime: process.uptime(),
  });
});

module.exports = router;
