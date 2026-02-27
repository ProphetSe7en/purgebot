const express = require('express');
const yaml = require('js-yaml');
const fs = require('fs');
const router = express.Router();
const bot = require('../../bot');

// GET /api/config — full config as JSON
router.get('/', (req, res) => {
  res.json(bot.config);
});

// PUT /api/config — replace full config
router.put('/', (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ error: 'Invalid config object' });
    }

    // Validate required fields
    if (newConfig.globalDefault !== undefined) {
      if (typeof newConfig.globalDefault !== 'number' || !Number.isInteger(newConfig.globalDefault) || newConfig.globalDefault < -1) {
        return res.status(400).json({ error: 'globalDefault must be integer >= -1' });
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
    if (updates.schedule !== undefined) cfg.schedule = String(updates.schedule);
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
      if (d.maxMessagesPerChannel !== undefined) cfg.discord.maxMessagesPerChannel = Math.max(1, Math.floor(Number(d.maxMessagesPerChannel) || 500));
      if (d.maxOldDeletesPerChannel !== undefined) cfg.discord.maxOldDeletesPerChannel = Math.max(0, Math.floor(Number(d.maxOldDeletesPerChannel) || 50));
      if (d.delayBetweenChannels !== undefined) cfg.discord.delayBetweenChannels = Math.max(0, Math.floor(Number(d.delayBetweenChannels) || 2000));
      if (d.skipPinned !== undefined) cfg.discord.skipPinned = !!d.skipPinned;
    }
    if (updates.logging !== undefined && typeof updates.logging === 'object') {
      if (updates.logging.maxDays !== undefined) cfg.logging.maxDays = Math.max(1, Math.floor(Number(updates.logging.maxDays) || 30));
    }
    if (updates.webhooks !== undefined && typeof updates.webhooks === 'object') {
      if (!cfg.webhooks) cfg.webhooks = {};
      if (updates.webhooks.cleanup !== undefined) cfg.webhooks.cleanup = String(updates.webhooks.cleanup || '');
      if (updates.webhooks.info !== undefined) cfg.webhooks.info = String(updates.webhooks.info || '');
    }

    // Write to disk
    const yamlStr = yaml.dump(cfg, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false });
    const tmpPath = bot.CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, bot.CONFIG_HEADER + yamlStr, 'utf8');
    fs.renameSync(tmpPath, bot.CONFIG_PATH);
    bot.fixOwnership(bot.CONFIG_PATH);

    // Re-setup cron if schedule or timezone changed (live update, no restart needed)
    if (updates.schedule !== undefined || updates.timezone !== undefined) {
      bot.setupCron();
    }

    bot.log('INFO', 'Global config updated via Web UI');
    res.json({ ok: true });
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

    // Write to disk
    const yamlStr = yaml.dump(cfg, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false });
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
