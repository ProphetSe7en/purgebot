const express = require('express');
const yaml = require('js-yaml');
const fs = require('fs');
const router = express.Router();
const bot = require('../../bot');
const audit = require('../audit');

// GET /api/config - full config as JSON (excludes internal keys, masks credentials)
router.get('/', (req, res) => {
  const { _discoveryComplete, timezone, ...rest } = bot.config;
  res.json(bot.maskedConfigSnapshot(rest));
});

// PUT /api/config - replace full config
router.put('/', (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ error: 'Invalid config object' });
    }

    // Strip internal/read-only keys that shouldn't be set via API
    // Preserve _discoveryComplete from current config (persisted, not exposed to UI)
    newConfig._discoveryComplete = bot.config._discoveryComplete;
    delete newConfig.timezone;

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

    // Resolve masked credentials against current stored values. A submitted
    // mask sentinel means "keep what's already stored"; any other value is
    // treated as a deliberate change.
    if (newConfig.webhooks && typeof newConfig.webhooks === 'object') {
      if (newConfig.webhooks.cleanup !== undefined) {
        newConfig.webhooks.cleanup = bot.resolveMaskedCredential(newConfig.webhooks.cleanup, bot.config.webhooks?.cleanup);
      }
      if (newConfig.webhooks.info !== undefined) {
        newConfig.webhooks.info = bot.resolveMaskedCredential(newConfig.webhooks.info, bot.config.webhooks?.info);
      }
    }
    if (newConfig.gotify && typeof newConfig.gotify === 'object' && newConfig.gotify.token !== undefined) {
      newConfig.gotify.token = bot.resolveMaskedCredential(newConfig.gotify.token, bot.config.gotify?.token);
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
    audit.record('config.write', {
      actor: audit.actorFromReq(req), ip: req.authContext?.ip,
      details: { method: 'PUT', scope: 'full', fields: Object.keys(newConfig || {}) },
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/config/global - update global settings
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
    // timezone is read-only (from TZ env var) - ignore if sent
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
      if (d.delayBetweenDeletes !== undefined) { const v = Number(d.delayBetweenDeletes); if (!isNaN(v)) cfg.discord.delayBetweenDeletes = Math.max(200, Math.floor(v)); }
      if (d.skipPinned !== undefined) cfg.discord.skipPinned = !!d.skipPinned;
    }
    if (updates.logging !== undefined && typeof updates.logging === 'object') {
      if (updates.logging.maxDays !== undefined) cfg.logging.maxDays = Math.max(1, Math.floor(Number(updates.logging.maxDays) || 30));
    }
    if (updates.webhooks !== undefined && typeof updates.webhooks === 'object') {
      if (!cfg.webhooks) cfg.webhooks = {};
      if (updates.webhooks.cleanup !== undefined) {
        cfg.webhooks.cleanup = bot.resolveMaskedCredential(String(updates.webhooks.cleanup || ''), cfg.webhooks.cleanup);
      }
      if (updates.webhooks.info !== undefined) {
        cfg.webhooks.info = bot.resolveMaskedCredential(String(updates.webhooks.info || ''), cfg.webhooks.info);
      }
      if (updates.webhooks.cleanupColor !== undefined) cfg.webhooks.cleanupColor = String(updates.webhooks.cleanupColor || '#238636');
      if (updates.webhooks.infoColor !== undefined) cfg.webhooks.infoColor = String(updates.webhooks.infoColor || '#f39c12');
      if (updates.webhooks.discovery !== undefined) cfg.webhooks.discovery = !!updates.webhooks.discovery;
    }
    if (updates.gotify !== undefined && typeof updates.gotify === 'object') {
      if (!cfg.gotify) cfg.gotify = {};
      if (updates.gotify.enabled !== undefined) cfg.gotify.enabled = !!updates.gotify.enabled;
      if (updates.gotify.url !== undefined) cfg.gotify.url = String(updates.gotify.url || '').replace(/\/+$/, '');
      if (updates.gotify.token !== undefined) {
        cfg.gotify.token = bot.resolveMaskedCredential(String(updates.gotify.token || ''), cfg.gotify.token);
      }
      if (updates.gotify.priorityWarning !== undefined) cfg.gotify.priorityWarning = !!updates.gotify.priorityWarning;
      if (updates.gotify.warningValue !== undefined) cfg.gotify.warningValue = Math.max(0, Math.floor(Number(updates.gotify.warningValue) || 0));
      if (updates.gotify.priorityInfo !== undefined) cfg.gotify.priorityInfo = !!updates.gotify.priorityInfo;
      if (updates.gotify.infoValue !== undefined) cfg.gotify.infoValue = Math.max(0, Math.floor(Number(updates.gotify.infoValue) || 0));
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

    // Re-setup cron if schedule or enabled state changed (live update, no restart needed)
    if (updates.schedule !== undefined || updates.scheduleEnabled !== undefined) {
      bot.setupCron();
    }

    bot.log('INFO', 'Global config updated via Web UI');
    audit.record('config.write', {
      actor: audit.actorFromReq(req), ip: req.authContext?.ip,
      details: { method: 'PATCH', scope: 'global', fields: Object.keys(updates || {}) },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/test-webhook - send a test message to a webhook URL
router.post('/test-webhook', async (req, res) => {
  try {
    const { type, url } = req.body;
    if (!type || !url) {
      return res.status(400).json({ error: 'Missing type or url' });
    }
    if (!['cleanup', 'info'].includes(type)) {
      return res.status(400).json({ error: 'Type must be "cleanup" or "info"' });
    }
    // If the UI sends the mask sentinel (user wants to test the stored URL
    // without re-entering it), resolve to the current stored value.
    const resolvedUrl = bot.resolveMaskedCredential(String(url), bot.config.webhooks?.[type]);
    if (!resolvedUrl) {
      return res.status(400).json({ error: 'No webhook URL configured to test' });
    }
    if (!bot.isAllowedDiscordWebhookUrl(resolvedUrl)) {
      return res.status(400).json({ error: 'URL must be a Discord webhook URL' });
    }

    const embed = {
      title: type === 'cleanup' ? 'PurgeBot - Webhook Test' : 'PurgeBot - Info Webhook Test',
      description: type === 'cleanup'
        ? 'This is a test message from PurgeBot. Cleanup summaries will appear here after each run.'
        : 'This is a test message from PurgeBot. Auto-discovery notifications will appear here when new channels are found.',
      color: type === 'cleanup'
        ? (parseInt((bot.config.webhooks?.cleanupColor || '#238636').replace('#', ''), 16) || 0x238636)
        : (parseInt((bot.config.webhooks?.infoColor || '#f39c12').replace('#', ''), 16) || 0xf39c12),
      footer: { text: `PurgeBot v${bot.version} by ProphetSe7en` },
      timestamp: new Date().toISOString(),
    };

    const r = await fetch(resolvedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (r.ok || r.status === 204) {
      bot.log('INFO', `Test ${type} webhook sent successfully`);
      audit.record('config.webhook_test', {
        actor: audit.actorFromReq(req), ip: req.authContext?.ip,
        details: { type, hostPrefix: (new URL(resolvedUrl)).host },
      });
      res.json({ ok: true });
    } else {
      const body = await r.text().catch(() => '');
      bot.log('WARN', `Test ${type} webhook failed: ${r.status} - ${body}`);
      res.status(400).json({ error: `Discord returned ${r.status}: ${body || 'Unknown error'}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/test-gotify - send a test message to Gotify
router.post('/test-gotify', async (req, res) => {
  try {
    const { url, token } = req.body;
    if (!url || !token) {
      return res.status(400).json({ error: 'Missing url or token' });
    }
    // Resolve mask sentinels against stored values so the user can test
    // the saved Gotify URL/token without re-entering them.
    const resolvedUrlRaw = bot.resolveMaskedCredential(String(url), bot.config.gotify?.url);
    const resolvedToken = bot.resolveMaskedCredential(String(token), bot.config.gotify?.token);
    if (!resolvedUrlRaw || !resolvedToken) {
      return res.status(400).json({ error: 'No Gotify URL/token configured to test' });
    }
    if (!bot.isAllowedGotifyUrl(resolvedUrlRaw)) {
      return res.status(400).json({ error: 'URL must be a valid http(s) URL' });
    }
    const gotifyUrl = resolvedUrlRaw.replace(/\/+$/, '');

    const payload = {
      title: 'PurgeBot - Test',
      message: 'This is a test message from PurgeBot. Cleanup summaries and auto-discovery notifications will appear here.',
      priority: 5,
      extras: { 'client::display': { contentType: 'text/markdown' } },
    };

    const r = await fetch(`${gotifyUrl}/message?token=${encodeURIComponent(resolvedToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (r.ok) {
      bot.log('INFO', 'Test Gotify message sent successfully');
      audit.record('config.gotify_test', {
        actor: audit.actorFromReq(req), ip: req.authContext?.ip,
        details: { hostPrefix: (new URL(gotifyUrl)).host },
      });
      res.json({ ok: true });
    } else {
      const body = await r.text().catch(() => '');
      bot.log('WARN', `Test Gotify message failed: ${r.status} - ${body}`);
      res.status(400).json({ error: `Gotify returned ${r.status}: ${body || 'Unknown error'}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/config/category/:name - update single category
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
    audit.record('config.write', {
      actor: audit.actorFromReq(req), ip: req.authContext?.ip,
      details: { method: 'PATCH', scope: 'category', category: catName, fields: Object.keys(updates || {}) },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
