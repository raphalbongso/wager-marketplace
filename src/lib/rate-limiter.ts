/**
 * Simple in-memory token bucket rate limiter.
 * Key = user ID or IP. Tokens refill over time.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private maxTokens: number;
  private refillRate: number; // tokens per second

  constructor(maxTokens = 30, refillRate = 5) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
  }

  consume(key: string, cost = 1): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Refill
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens < cost) {
      return false; // Rate limited
    }

    bucket.tokens -= cost;
    return true;
  }

  /** Periodic cleanup of stale buckets */
  cleanup() {
    const staleThreshold = Date.now() - 60_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < staleThreshold) {
        this.buckets.delete(key);
      }
    }
  }
}

export const globalLimiter = new RateLimiter(30, 5);

// Cleanup every 60s
setInterval(() => globalLimiter.cleanup(), 60_000).unref();
