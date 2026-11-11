/**
 * Fixed-window request limiter keyed by client (see `rateLimitKey` in http.ts). In memory,
 * per server process; use a shared store (Redis, your API gateway) when you run several instances.
 */
export class RateLimiter {
  private windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
      if (this.windows.size > 10_000) this.dropExpired(now);
    }
    window.count += 1;
    if (window.count <= this.limit) return { allowed: true };
    return { allowed: false, retryAfterSeconds: Math.ceil((window.startedAt + this.windowMs - now) / 1000) };
  }

  private dropExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}
