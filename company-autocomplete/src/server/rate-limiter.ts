export interface RateLimit {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

/** `release` gives the slot back, for work that turned out to cost nothing. */
export type RateLimitDecision = { allowed: true; release: () => void } | { allowed: false; retryAfterSeconds: number };

// Past this many tracked clients, expired windows are swept on the next call.
const SWEEP_THRESHOLD = 10_000;

/**
 * Fixed-window counter per key (here, per client IP). Simple and predictable:
 * each key gets `limit` requests, and the count resets `windowMs` after the
 * first one. In-memory, so per process, like the cache.
 */
export class FixedWindowRateLimiter {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options: RateLimit & { now?: () => number }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  /** Counts one request for `key` and says whether it may go ahead. */
  consume(key: string): RateLimitDecision {
    const now = this.#now();
    if (this.#windows.size > SWEEP_THRESHOLD) this.#sweep(now);

    let window = this.#windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.#windowMs };
      this.#windows.set(key, window);
    }
    if (window.count >= this.#limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((window.resetAt - now) / 1000) };
    }
    window.count += 1;
    const counted = window;
    return {
      allowed: true,
      // Only within the same window: a slot from an expired window is already free.
      release: () => {
        if (this.#windows.get(key) === counted && counted.count > 0) counted.count -= 1;
      },
    };
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key);
    }
  }
}
