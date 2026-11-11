import { CreditBudget } from '@/lib/credits';

/**
 * Process-wide spend caps for the web server. Each paid request gets a child budget,
 * so the total spent since the server started can never pass these, however many
 * requests a client sends. They reset when the server restarts.
 */
function capFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number of credits, got "${raw}".`);
  return value;
}

export const serverBudgets = {
  /** People searches and workforce checks via /api/map. */
  map: new CreditBudget(capFromEnv('MAP_MAX_CREDITS', 300)),
  /** Email reveals via /api/reveal: 50 credits is 5 newly found emails. */
  reveal: new CreditBudget(capFromEnv('REVEAL_MAX_CREDITS', 50)),
};

/** Upper bound for one /api/map call, whatever the browser asks for. */
export const MAX_CREDITS_PER_MAP_REQUEST = 500;
