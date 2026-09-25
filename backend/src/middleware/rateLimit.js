import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const limiters = new Set();

export function createRateLimiter({ windowMs = 60_000, max = 60, key, limitStatus = "rate_limited", ...options } = {}) {
  const limiter = rateLimit({
    ...options,
    windowMs,
    max,
    keyGenerator: key || ((req) => ipKeyGenerator(req.ip || "unknown")),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    passOnStoreError: false,
    handler: (req, res) => {
      const retryAfter = Math.max(1, Math.ceil((req.rateLimit?.resetTime?.getTime?.() - Date.now()) / 1000) || Math.ceil(windowMs / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ ok: false, status: limitStatus, retry_after: retryAfter });
    }
  });
  limiters.add(limiter);
  return limiter;
}

export function clearRateLimitBuckets() {
  for (const limiter of limiters) limiter.store?.resetAll?.();
}
