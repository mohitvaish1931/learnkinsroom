// Fixed-window, per-key rate limiter kept in memory.
// On serverless hosts each instance has its own window, so treat this as abuse
// protection (stops a runaway client burning the AI quota), not exact metering.

function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map(); // key -> { count, resetAt }

  function take(key) {
    const t = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (hits.size > 10000) {
      for (const [k, e] of hits) if (e.resetAt <= t) hits.delete(k);
    }
    return {
      ok: entry.count <= limit,
      remaining: Math.max(0, limit - entry.count),
      retryAfterSec: Math.ceil((entry.resetAt - t) / 1000)
    };
  }

  // Express middleware keyed by the authenticated user (falls back to IP).
  function middleware(name) {
    return (req, res, next) => {
      const key = `${name}:${req.user?.uid || req.ip}`;
      const r = take(key);
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(r.remaining));
      if (r.ok) return next();
      res.setHeader('Retry-After', String(r.retryAfterSec));
      res.status(429).json({ error: `Too many requests — try again in ${r.retryAfterSec}s` });
    };
  }

  return { take, middleware };
}

module.exports = { createRateLimiter };
