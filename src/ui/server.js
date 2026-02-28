const express = require('express');
const path = require('path');
const { log } = require('../bot');

const configRoutes = require('./routes/config');
const statsRoutes = require('./routes/stats');
const controlRoutes = require('./routes/control');
const logsRoutes = require('./routes/logs');

const UI_PORT = parseInt(process.env.UI_PORT || '3050', 10);

function startServer() {
  const app = express();

  app.use(express.json({ limit: '50kb' }));

  // Simple rate limiter for state-changing API calls (60 req/min per IP)
  const rateLimitMap = new Map();
  setInterval(() => rateLimitMap.clear(), 60000);

  // CSRF protection + rate limiting on state-changing API calls
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
        return res.status(403).json({ error: 'Missing X-Requested-With header' });
      }
      const ip = req.ip;
      const count = (rateLimitMap.get(ip) || 0) + 1;
      rateLimitMap.set(ip, count);
      if (count > 60) {
        return res.status(429).json({ error: 'Too many requests' });
      }
    }
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // API routes
  app.use('/api/config', configRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/cleanup', controlRoutes);
  app.use('/api/logs', logsRoutes);

  // SPA fallback
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  const server = app.listen(UI_PORT, () => {
    log('INFO', `Web UI available at http://0.0.0.0:${UI_PORT}`);
  });

  return server;
}

module.exports = { startServer };
