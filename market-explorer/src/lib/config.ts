/**
 * Server settings from the environment. The defaults are the safe ones for a
 * public deployment: paid search is off unless explicitly enabled, and even
 * then it is capped per day and per client address.
 */

export interface ServerConfig {
  apiKey: string | undefined;
  /** `ENABLE_PAID_SEARCH=true` turns on `/api/search`. Anything else keeps the app free-only. */
  paidSearchEnabled: boolean;
  /** Process-wide cap on paid-search credits per UTC day. */
  maxCreditsPerDay: number;
  /** Paid searches allowed per client address per rolling hour. */
  maxPaidSearchesPerIpPerHour: number;
  /** `TRUST_PROXY=1`: a reverse proxy you run appends the client address to `X-Forwarded-For`. */
  trustProxy: boolean;
  /** Set by Vercel itself (`VERCEL=1`), whose edge sets `x-vercel-forwarded-for`. */
  onVercel: boolean;
}

export const DEFAULT_MAX_CREDITS_PER_DAY = 50;
export const DEFAULT_MAX_PAID_SEARCHES_PER_IP_PER_HOUR = 5;

/** A setting in the environment is malformed. The message names the variable. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

function wholeNumber(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number of 0 or more (got "${raw}").`);
  return Number(raw);
}

export function readConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    apiKey: env.COMPANYENRICH_API_KEY?.trim() || undefined,
    paidSearchEnabled: env.ENABLE_PAID_SEARCH?.trim().toLowerCase() === 'true',
    maxCreditsPerDay: wholeNumber(env, 'SEARCH_MAX_CREDITS_PER_DAY', DEFAULT_MAX_CREDITS_PER_DAY),
    maxPaidSearchesPerIpPerHour: wholeNumber(
      env,
      'SEARCH_MAX_PER_IP_PER_HOUR',
      DEFAULT_MAX_PAID_SEARCHES_PER_IP_PER_HOUR,
    ),
    trustProxy: ['1', 'true'].includes(env.TRUST_PROXY?.trim().toLowerCase() ?? ''),
    onVercel: env.VERCEL === '1',
  };
}
