// Token-bucket rate-limiter. Node port of clonarr's internal/auth/ratelimit.go.
//
// Each IP gets its own bucket. A bucket has a capacity (`burst`) and refills
// at a steady rate. Each allowed request consumes one token. When the bucket
// is empty, requests are rejected with 429 + Retry-After.
//
// Two preconfigured buckets:
//   - api      burst=30, refill=2/sec   - covers /api/* generally
//   - login    burst=5,  refill=1/60sec - covers /api/auth/login + /api/auth/setup
//
// A background sweeper purges idle buckets every minute. Panic-recovery wraps
// the sweeper body so a single bad timer event can't kill the goroutine.

class TokenBucket {
  constructor({ burst, refillPerSec }) {
    this.capacity = burst;
    this.tokens = burst;
    this.refillRate = refillPerSec; // tokens per second
    this.lastRefillMs = Date.now();
  }

  _refill(now) {
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    const add = elapsedSec * this.refillRate;
    if (add > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + add);
      this.lastRefillMs = now;
    }
  }

  // Try to consume one token. Returns { ok, retryAfterSec }.
  consume() {
    const now = Date.now();
    this._refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true, retryAfterSec: 0 };
    }
    // Time to next whole token
    const need = 1 - this.tokens;
    const secs = Math.ceil(need / this.refillRate);
    return { ok: false, retryAfterSec: Math.max(1, secs) };
  }

  idle(now, idleMs) {
    return (now - this.lastRefillMs) > idleMs && this.tokens >= this.capacity;
  }
}

class Limiter {
  constructor({ burst, refillPerSec, name, logger, idleMs = 5 * 60 * 1000 }) {
    this.burst = burst;
    this.refillPerSec = refillPerSec;
    this.name = name || 'limiter';
    this.logger = logger || (() => {});
    this.idleMs = idleMs;
    this.buckets = new Map();
    this._sweeper = setInterval(() => {
      try { this._sweep(); }
      catch (err) { this.logger('WARN', `${this.name} sweeper error: ${err.message}`); }
    }, 60 * 1000);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  _sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.idle(now, this.idleMs)) {
        this.buckets.delete(key);
        removed++;
      }
    }
    if (removed > 0) this.logger('DEBUG', `${this.name} swept ${removed} idle bucket(s)`);
  }

  // Returns { ok, retryAfterSec } for the given key (typically client IP).
  consume(key) {
    if (!key) key = 'unknown';
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket({ burst: this.burst, refillPerSec: this.refillPerSec });
      this.buckets.set(key, b);
    }
    return b.consume();
  }

  // Express middleware factory. Uses clientIpFn(req) to pick the key -
  // pass the AuthStore's clientIp method so trusted-proxy hops are honored.
  middleware(clientIpFn, onLimit) {
    return (req, res, next) => {
      const key = clientIpFn ? clientIpFn(req) : (req.ip || 'unknown');
      const result = this.consume(key);
      if (result.ok) return next();
      res.set('Retry-After', String(result.retryAfterSec));
      if (onLimit) {
        try { onLimit({ req, key, retryAfterSec: result.retryAfterSec }); }
        catch (_) {}
      }
      const wantsJson = req.path.startsWith('/api/') || req.get('accept')?.includes('application/json');
      if (wantsJson) {
        return res.status(429).json({ error: 'too many requests', retryAfter: result.retryAfterSec });
      }
      return res.status(429).type('text/plain').send(`Too many requests. Try again in ${result.retryAfterSec}s.`);
    };
  }
}

module.exports = { Limiter, TokenBucket };
