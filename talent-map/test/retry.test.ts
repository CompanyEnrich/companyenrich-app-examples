import { RateLimitError, ServerError } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { retryOnRateLimit } from '../src/lib/retry.js';

const error = (Kind: typeof RateLimitError | typeof ServerError, status: number) => new Kind({ status, headers: new Headers(), body: {} });

describe('retryOnRateLimit', () => {
  it('retries a 429 and returns the later success', async () => {
    let calls = 0;
    const result = await retryOnRateLimit(async () => {
      calls++;
      if (calls < 3) throw error(RateLimitError, 429);
      return 'ok';
    }, 3, 1);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the last attempt', async () => {
    let calls = 0;
    const failing = retryOnRateLimit(async () => {
      calls++;
      throw error(RateLimitError, 429);
    }, 2, 1);
    await expect(failing).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toBe(2);
  });

  it('never repeats a call that failed for any other reason, since it may have been billed', async () => {
    let calls = 0;
    const failing = retryOnRateLimit(async () => {
      calls++;
      throw error(ServerError, 500);
    }, 3, 1);
    await expect(failing).rejects.toBeInstanceOf(ServerError);
    expect(calls).toBe(1);
  });
});
