import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const limiters = new Set();

export function createRateLimiter({ windowMs = 60_000, max = 60, key, ...options } = {}) {
  const limiter = rateLimit({
    ...options,
    windowMs,
    max,
    keyGenerator: key || ((req) => ipKeyGenerator(req.ip || "unknown")),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    passOnStoreError: false,
    handler: (_req, res) => {
      res.set("Retry-After", String(Math.max(1, Math.ceil(windowMs / 1000))));
      return res.status(429).json({ ok: false, status: "rate_limited" });
    }
  });
  limiters.add(limiter);
  return limiter;
}

export function clearRateLimitBuckets() {
  for (const limiter of limiters) limiter.store?.resetAll?.();
}
