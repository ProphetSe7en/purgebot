const express = require('express');
const router = express.Router();
const bot = require('../../bot');

// GET /api/webhooks — fetch all guild webhooks grouped by category/channel
router.get('/', async (req, res) => {
  if (!bot.client.isReady()) {
    return res.status(503).json({ error: 'Discord bot is not connected' });
  }
  try {
    const data = await bot.fetchGuildWebhooks();
    res.json(data);
  } catch (err) {
    // Discord error 50013 = Missing Permissions
    if (err.code === 50013) {
      return res.status(403).json({ error: 'Bot lacks Manage Webhooks permission. Add it in Server Settings → Roles.' });
    }
    bot.log('ERROR', `Webhook discovery failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
