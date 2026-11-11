export const DEFAULT_FETCH_LIMIT = 5;
export const MAX_FETCH_LIMIT = 25;

export type Command =
  | { kind: 'help' }
  | { kind: 'balance' }
  | { kind: 'company'; domain: string }
  | { kind: 'count'; target: 'companies' | 'people'; query: string }
  | { kind: 'people'; domain: string; roles: string; limit: number }
  | { kind: 'lookalikes'; domain: string; limit: number }
  | { kind: 'invalid'; message: string };

const USAGE = {
  company: 'Usage: `/ce company <domain>`, for example `/ce company stripe.com`.',
  count: 'Usage: `/ce count <plain English>` or `/ce count people <plain English>`, for example `/ce count fintech startups in Berlin`.',
  people: 'Usage: `/ce people <domain> <role words> [n]`, for example `/ce people stripe.com vp sales 3`.',
  lookalikes: 'Usage: `/ce lookalikes <domain> [n]`, for example `/ce lookalikes stripe.com 5`.',
};

/** Parse the text after `/ce`. Never throws: bad input becomes `{ kind: 'invalid' }`. */
export function parseCommand(input: string): Command {
  const words = input.trim().split(/\s+/).filter(Boolean);
  const [head, ...rest] = words;
  if (!head) return { kind: 'help' };

  switch (head.toLowerCase()) {
    case 'help':
      return { kind: 'help' };
    case 'balance':
      return { kind: 'balance' };
    case 'company': {
      const domain = rest.length === 1 ? normalizeDomain(rest[0] ?? '') : undefined;
      return domain ? { kind: 'company', domain } : invalid(USAGE.company);
    }
    case 'count': {
      const target = rest[0]?.toLowerCase() === 'people' ? 'people' : 'companies';
      const queryWords = ['people', 'companies'].includes(rest[0]?.toLowerCase() ?? '') ? rest.slice(1) : rest;
      const query = queryWords.join(' ');
      return query ? { kind: 'count', target, query } : invalid(USAGE.count);
    }
    case 'people': {
      const domain = normalizeDomain(rest[0] ?? '');
      // A trailing number is the fetch size, not part of the role words.
      const lastWord = rest.length > 2 ? (rest.at(-1) ?? '') : '';
      const hasLimit = /^\d+$/.test(lastWord);
      const roleWords = rest.slice(1, hasLimit ? -1 : undefined);
      const limit = hasLimit ? parseLimit(lastWord) : DEFAULT_FETCH_LIMIT;
      if (!domain || roleWords.length === 0) return invalid(USAGE.people);
      if (limit === undefined) return invalid(`n must be between 1 and ${MAX_FETCH_LIMIT}. ${USAGE.people}`);
      return { kind: 'people', domain, roles: roleWords.join(' '), limit };
    }
    case 'lookalikes':
    case 'similar': {
      const domain = normalizeDomain(rest[0] ?? '');
      const limit = rest[1] === undefined ? DEFAULT_FETCH_LIMIT : parseLimit(rest[1]);
      if (!domain || rest.length > 2) return invalid(USAGE.lookalikes);
      if (limit === undefined) return invalid(`n must be between 1 and ${MAX_FETCH_LIMIT}. ${USAGE.lookalikes}`);
      return { kind: 'lookalikes', domain, limit };
    }
    default:
      return invalid(`Unknown command "${head}". Try \`/ce help\`.`);
  }
}

/**
 * Reduce user input to a bare domain: `https://www.Stripe.com/pricing` -> `stripe.com`.
 * Also unwraps Slack's link markup, `<http://stripe.com|stripe.com>`.
 */
export function normalizeDomain(input: string): string | undefined {
  let value = input.trim();
  const slackLink = /^<([^|>]+)(?:\|[^>]*)?>$/.exec(value);
  if (slackLink?.[1]) value = slackLink[1];
  value = value
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#:].*$/, '');
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$/.test(value) ? value : undefined;
}

function parseLimit(token: string): number | undefined {
  if (!/^\d+$/.test(token)) return undefined;
  const value = Number(token);
  return value >= 1 && value <= MAX_FETCH_LIMIT ? value : undefined;
}

function invalid(message: string): Command {
  return { kind: 'invalid', message };
}
