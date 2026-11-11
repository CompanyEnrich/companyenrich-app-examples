import { normalizeDomain } from './domains';

/** Your company plus up to 8 peers. */
export const MAX_PEERS = 8;
export const MAX_COMPANIES = MAX_PEERS + 1;
export const MAX_SUGGESTED = MAX_PEERS;
export const DEFAULT_SUGGESTED = 5;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Paid routes answer with a free estimate unless the body says `confirm: true`
 * and gives `maxCredits`, the cost the user saw. The server refuses to spend more.
 */
export type Spend = { confirm: false } | { confirm: true; maxCredits: number };

export type BenchmarkRequest = Spend & {
  company: string;
  peers: string[];
};

export type SuggestRequest = Spend & {
  company: string;
  /** How many lookalikes to buy. */
  count: number;
  /** Peers already picked: excluded from suggestions and counted against MAX_PEERS. */
  peers: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDomain(value: unknown, field: string): Parsed<string> {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, error: `${field} is required.` };
  const domain = normalizeDomain(value);
  return domain ? { ok: true, value: domain } : { ok: false, error: `${field} "${value.slice(0, 80)}" is not a valid domain.` };
}

/** Normalizes, drops duplicates and the subject itself, and enforces `max`. */
function parsePeers(value: unknown, company: string, max: number): Parsed<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'peers must be an array of domains.' };
  if (value.length > max) return { ok: false, error: `At most ${max} peers are allowed (${MAX_COMPANIES} companies in total).` };

  const peers: string[] = [];
  for (const item of value) {
    const parsed = parseDomain(item, 'Peer');
    if (!parsed.ok) return parsed;
    if (parsed.value !== company && !peers.includes(parsed.value)) peers.push(parsed.value);
  }
  return { ok: true, value: peers };
}

function parseSpend(body: Record<string, unknown>): Parsed<Spend> {
  if (body.confirm !== true) return { ok: true, value: { confirm: false } };
  const maxCredits = body.maxCredits;
  if (typeof maxCredits !== 'number' || !Number.isInteger(maxCredits) || maxCredits < 0) {
    return { ok: false, error: 'confirm: true needs maxCredits, the whole number of credits you agreed to spend.' };
  }
  return { ok: true, value: { confirm: true, maxCredits } };
}

export function parseBenchmarkRequest(body: unknown): Parsed<BenchmarkRequest> {
  if (!isRecord(body)) return { ok: false, error: 'Send a JSON object: { company, peers, confirm?, maxCredits? }.' };
  const company = parseDomain(body.company, 'company');
  if (!company.ok) return company;
  const peers = parsePeers(body.peers, company.value, MAX_PEERS);
  if (!peers.ok) return peers;
  if (peers.value.length === 0) return { ok: false, error: 'Pick at least one peer that is not the company itself.' };
  const spend = parseSpend(body);
  if (!spend.ok) return spend;
  return { ok: true, value: { company: company.value, peers: peers.value, ...spend.value } };
}

export function parseSuggestRequest(body: unknown): Parsed<SuggestRequest> {
  if (!isRecord(body)) return { ok: false, error: 'Send a JSON object: { company, count?, peers?, confirm?, maxCredits? }.' };
  const company = parseDomain(body.company, 'company');
  if (!company.ok) return company;
  const peers = parsePeers(body.peers, company.value, MAX_PEERS);
  if (!peers.ok) return peers;

  const count = body.count ?? DEFAULT_SUGGESTED;
  const room = MAX_PEERS - peers.value.length;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_SUGGESTED) {
    return { ok: false, error: `count must be a whole number from 1 to ${MAX_SUGGESTED}.` };
  }
  if (count > room) {
    return { ok: false, error: `Only ${room} peer slot${room === 1 ? '' : 's'} left (max ${MAX_PEERS} peers).` };
  }

  const spend = parseSpend(body);
  if (!spend.ok) return spend;
  return { ok: true, value: { company: company.value, count, peers: peers.value, ...spend.value } };
}
