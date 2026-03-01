const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const bot = require('../../bot');

// GET /api/logs — read log files
router.get('/', (req, res) => {
  try {
    const { date, level, search, limit: rawLimit } = req.query;
    const limit = parseInt(rawLimit) || 200;

    // Validate date format to prevent path traversal
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format (expected YYYY-MM-DD)' });
    }

    // Determine which log file(s) to read
    let logFile;
    if (date) {
      logFile = path.join(bot.LOG_DIR, `purgebot-${date}.log`);
    } else {
      // Latest: today's log
      const today = new Date().toISOString().split('T')[0];
      logFile = path.join(bot.LOG_DIR, `purgebot-${today}.log`);
    }

    if (!fs.existsSync(logFile)) {
      return res.json({ lines: [], file: path.basename(logFile) });
    }

    let lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);

    // Filter by level
    if (level) {
      const upperLevel = level.toUpperCase();
      lines = lines.filter(l => l.includes(`[${upperLevel}]`));
    }

    // Filter by search term
    if (search) {
      const term = search.toLowerCase();
      lines = lines.filter(l => l.toLowerCase().includes(term));
    }

    // Return last N lines (most recent)
    const result = lines.slice(-limit);

    // List available log files
    let files = [];
    try {
      files = fs.readdirSync(bot.LOG_DIR)
        .filter(f => f.startsWith('purgebot-') && f.endsWith('.log'))
        .sort()
        .reverse();
    } catch {}

    res.json({ lines: result, file: path.basename(logFile), files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/stream — SSE endpoint for live logs
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial connection event
  res.write('data: {"type":"connected"}\n\n');

  // Guard writes — disconnected client can throw ERR_STREAM_DESTROYED
  // which propagates synchronously through EventEmitter.emit() into callers
  function safeSend(str) {
    try { if (!res.destroyed) res.write(str); } catch {}
  }

  // Forward log events
  const onLog = (entry) => {
    safeSend(`data: ${JSON.stringify(entry)}\n\n`);
  };

  // Forward cleanup-complete events
  const onCleanupComplete = (stats) => {
    safeSend(`event: cleanup-complete\ndata: ${JSON.stringify(stats)}\n\n`);
  };

  const onCleanupProgress = (data) => {
    safeSend(`event: cleanup-progress\ndata: ${JSON.stringify(data)}\n\n`);
  };

  bot.logEmitter.on('log', onLog);
  bot.logEmitter.on('cleanup-complete', onCleanupComplete);
  bot.logEmitter.on('cleanup-progress', onCleanupProgress);

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    safeSend(': heartbeat\n\n');
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    bot.logEmitter.removeListener('log', onLog);
    bot.logEmitter.removeListener('cleanup-complete', onCleanupComplete);
    bot.logEmitter.removeListener('cleanup-progress', onCleanupProgress);
    clearInterval(heartbeat);
  });
});

module.exports = router;
