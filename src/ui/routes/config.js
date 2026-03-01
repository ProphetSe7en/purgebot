const express = require('express');
const yaml = require('js-yaml');
const fs = require('fs');
const router = express.Router();
const bot = require('../../bot');

// GET /api/config — full config as JSON (excludes internal keys)
router.get('/', (req, res) => {
  const { _discoveryComplete, ...rest } = bot.config;
  res.json(rest);
});

// PUT /api/config — replace full config
router.put('/', (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ error: 'Invalid config object' });
    }

    // Strip internal keys that shouldn't be set via API
    delete newConfig._discoveryComplete;

    // Validate required fields
    if (newConfig.globalDefault !== undefined) {
      if (typeof newConfig.globalDefault !== 'number' || !Number.isInteger(newConfig.globalDefault) || newConfig.globalDefault < -1) {
        return res.status(400).json({ error: 'globalDefault must be integer >= -1' });
      }
    }

    // Validate schedule if provided
    const cron = require('node-cron');
    if (newConfig.schedule !== undefined && !cron.validate(String(newConfig.schedule))) {
      return res.status(400).json({ error: `Invalid cron schedule: "${newConfig.schedule}"` });
    }

    // Validate categories structure
    if (newConfig.categories !== undefined) {
      if (typeof newConfig.categories !== 'object' || Array.isArray(newConfig.categories)) {
        return res.status(400).json({ error: 'categories must be an object' });
      }
    }

    const yamlStr = yaml.dump(newConfig, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false });
    const tmpPath = bot.CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, bot.CONFIG_HEADER + yamlStr, 'utf8');
    fs.renameSync(tmpPath, bot.CONFIG_PATH);
    bot.fixOwnership(bot.CONFIG_PATH);

    // Reload config into live bot + re-setup cron (schedule may have changed)
    bot.loadConfig(false);
    bot.setupCron();
    bot.log('INFO', 'Config updated via Web UI');

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/config/global — update global settings
router.patch('/global', (req, res) => {
  try {
    const updates = req.body;
    const cfg = bot.config;

    // Apply allowed global fields
    if (updates.schedule !== undefined) {
      const cron = require('node-cron');
      if (!cron.validate(String(updates.schedule))) {
        return res.status(400).json({ error: `Invalid cron schedule: "${updates.schedule}"` });
      }
      cfg.schedule = String(updates.schedule);
    }
    if (updates.timezone !== undefined) cfg.timezone = String(updates.timezone);
    if (updates.globalDefault !== undefined) {
      if (typeof updates.globalDefault !== 'number' || !Number.isInteger(updates.globalDefault) || updates.globalDefault < -1) {
        return res.status(400).json({ error: 'globalDefault must be integer >= -1' });
      }
      cfg.globalDefault = updates.globalDefault;
    }
    if (updates.dryRun !== undefined) cfg.dryRun = !!updates.dryRun;
    // Whitelist discord sub-fields
    if (updates.discord !== undefined && typeof updates.discord === 'object') {
      const d = updates.discord;
      if (d.maxMessagesPerChannel !== undefined) { const v = Number(d.maxMessagesPerChannel); if (!isNaN(v)) cfg.discord.maxMessagesPerChannel = Math.max(1, Math.floor(v)); }
      if (d.maxOldDeletesPerChannel !== undefined) { const v = Number(d.maxOldDeletesPerChannel); if (!isNaN(v)) cfg.discord.maxOldDeletesPerChannel = Math.max(0, Math.floor(v)); }
      if (d.delayBetweenChannels !== undefined) { const v = Number(d.delayBetweenChannels); if (!isNaN(v)) cfg.discord.delayBetweenChannels = Math.max(0, Math.floor(v)); }
      if (d.skipPinned !== undefined) cfg.discord.skipPinned = !!d.skipPinned;
    }
    if (updates.logging !== undefined && typeof updates.logging === 'object') {
      if (updates.logging.maxDays !== undefined) cfg.logging.maxDays = Math.max(1, Math.floor(Number(updates.logging.maxDays) || 30));
    }
    if (updates.webhooks !== undefined && typeof updates.webhooks === 'object') {
      if (!cfg.webhooks) cfg.webhooks = {};
      if (updates.webhooks.cleanup !== undefined) cfg.webhooks.cleanup = String(updates.webhooks.cleanup || '');
      if (updates.webhooks.info !== undefined) cfg.webhooks.info = String(updates.webhooks.info || '');
      if (updates.webhooks.cleanupColor !== undefined) cfg.webhooks.cleanupColor = String(updates.webhooks.cleanupColor || '#238636');
      if (updates.webhooks.infoColor !== undefined) cfg.webhooks.infoColor = String(updates.webhooks.infoColor || '#f39c12');
    }
    if (updates.scheduleEnabled !== undefined) cfg.scheduleEnabled = !!updates.scheduleEnabled;
    if (updates.display !== undefined && typeof updates.display === 'object') {
      if (!cfg.display) cfg.display = {};
      if (updates.display.timeFormat !== undefined) {
        cfg.display.timeFormat = ['12h', '24h'].includes(updates.display.timeFormat) ? updates.display.timeFormat : '24h';
      }
    }

    // Write to disk (strip internal keys)
    const yamlStr = yaml.dump(bot.configForDisk(), { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false });
    const tmpPath = bot.CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, bot.CONFIG_HEADER + yamlStr, 'utf8');
    fs.renameSync(tmpPath, bot.CONFIG_PATH);
    bot.fixOwnership(bot.CONFIG_PATH);

    // Re-setup cron if schedule, timezone, or enabled state changed (live update, no restart needed)
    if (updates.schedule !== undefined || updates.timezone !== undefined || updates.scheduleEnabled !== undefined) {
      bot.setupCron();
    }

    bot.log('INFO', 'Global config updated via Web UI');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/test-webhook — send a test message to a webhook URL
router.post('/test-webhook', async (req, res) => {
  try {
    const { type, url } = req.body;
    if (!type || !url) {
      return res.status(400).json({ error: 'Missing type or url' });
    }
    if (!['cleanup', 'info'].includes(type)) {
      return res.status(400).json({ error: 'Type must be "cleanup" or "info"' });
    }
    if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) {
      return res.status(400).json({ error: 'URL must be a Discord webhook URL' });
    }

    const embed = {
      title: type === 'cleanup' ? 'PurgeBot — Webhook Test' : 'PurgeBot — Info Webhook Test',
      description: type === 'cleanup'
        ? 'This is a test message from PurgeBot. Cleanup summaries will appear here after each run.'
        : 'This is a test message from PurgeBot. Auto-discovery notifications will appear here when new channels are found.',
      color: type === 'cleanup'
        ? (parseInt((bot.config.webhooks?.cleanupColor || '#238636').replace('#', ''), 16) || 0x238636)
        : (parseInt((bot.config.webhooks?.infoColor || '#f39c12').replace('#', ''), 16) || 0xf39c12),
      footer: { text: 'PurgeBot' },
      timestamp: new Date().toISOString(),
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (r.ok || r.status === 204) {
      bot.log('INFO', `Test ${type} webhook sent successfully`);
      res.json({ ok: true });
    } else {
      const body = await r.text().catch(() => '');
      bot.log('WARN', `Test ${type} webhook failed: ${r.status} — ${body}`);
      res.status(400).json({ error: `Discord returned ${r.status}: ${body || 'Unknown error'}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/config/category/:name — update single category
router.patch('/category/:name', (req, res) => {
  try {
    const catName = req.params.name;
    const updates = req.body;
    const cfg = bot.config;

    if (!cfg.categories[catName]) {
      return res.status(404).json({ error: `Category "${catName}" not found` });
    }

    const cat = cfg.categories[catName];
    if (updates.enabled !== undefined) cat.enabled = !!updates.enabled;
    if (updates.default !== undefined) {
      if (typeof updates.default !== 'number' || !Number.isInteger(updates.default) || updates.default < -1) {
        return res.status(400).json({ error: 'default must be integer >= -1' });
      }
      cat.default = updates.default;
    }
    if (updates._channels !== undefined) {
      if (!Array.isArray(updates._channels)) {
        return res.status(400).json({ error: '_channels must be an array' });
      }
      // Validate: each entry must be a string or a single-key object with integer value
      for (const entry of updates._channels) {
        if (typeof entry === 'string') continue;
        if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
          const keys = Object.keys(entry);
          if (keys.length === 1 && typeof keys[0] === 'string' && Number.isInteger(entry[keys[0]]) && entry[keys[0]] >= -1) continue;
        }
        return res.status(400).json({ error: '_channels entries must be strings or {name: days} objects' });
      }
      cat._channels = updates._channels;
    }

    // Write to disk (strip internal keys)
    const yamlStr = yaml.dump(bot.configForDisk(), { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false });
    const tmpPath = bot.CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, bot.CONFIG_HEADER + yamlStr, 'utf8');
    fs.renameSync(tmpPath, bot.CONFIG_PATH);
    bot.fixOwnership(bot.CONFIG_PATH);

    bot.log('INFO', `Category "${catName}" updated via Web UI`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
