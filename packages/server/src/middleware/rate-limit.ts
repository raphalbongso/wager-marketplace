/**
 * Simple in-memory token-bucket rate limiter.
 * Used as a Fastify hook, keyed by user ID (authenticated) or IP (anonymous).
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();
const MAX_TOKENS = 60; // requests
const REFILL_INTERVAL_MS = 60_000; // per minute
const REFILL_RATE = MAX_TOKENS; // tokens per interval

export function getRateLimitKey(request: { user?: { sub: string }; ip: string }): string {
  return request.user?.sub ?? request.ip;
}

export function checkRateLimit(key: string): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: MAX_TOKENS, lastRefill: now };
    buckets.set(key, bucket);
  }

  // Refill tokens
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= REFILL_INTERVAL_MS) {
    const intervals = Math.floor(elapsed / REFILL_INTERVAL_MS);
    bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + intervals * REFILL_RATE);
    bucket.lastRefill += intervals * REFILL_INTERVAL_MS;
  }

  if (bucket.tokens <= 0) {
    return false;
  }

  bucket.tokens -= 1;
  return true;
}

// Periodic cleanup of stale buckets (every 5 minutes)
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [key, bucket] of buckets) {
    if (bucket.lastRefill < cutoff) {
      buckets.delete(key);
    }
  }
}, 5 * 60_000).unref();
