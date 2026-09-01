const buckets = new Map();

export function createRateLimiter({ windowMs = 60_000, max = 60, key = (req) => req.ip || "unknown" } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = String(key(req));
    const current = buckets.get(bucketKey);
    const bucket = !current || current.expiresAt <= now
      ? { count: 0, expiresAt: now + windowMs }
      : current;
    if (!current && buckets.size > 10_000) {
      for (const [keyName, entry] of buckets) if (entry.expiresAt <= now) buckets.delete(keyName);
    }
    bucket.count += 1;
    buckets.set(bucketKey, bucket);
    if (bucket.count > max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))));
      return res.status(429).json({ ok: false, status: "rate_limited" });
    }
    return next();
  };
}

export function clearRateLimitBuckets() {
  buckets.clear();
}
