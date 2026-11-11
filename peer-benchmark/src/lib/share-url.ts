import { normalizeDomain } from './domains';
import { MAX_PEERS } from './requests';

export interface Selection {
  company: string | null;
  peers: string[];
}

/** `?company=posthog.com&peers=mixpanel.com,amplitude.com`. Only domains: never the key. */
export function selectionToQuery(selection: Selection): string {
  const params = new URLSearchParams();
  if (selection.company) params.set('company', selection.company);
  if (selection.peers.length > 0) params.set('peers', selection.peers.join(','));
  // Keep the commas readable in shared links.
  return params.toString().replaceAll('%2C', ',');
}

type QueryValue = string | string[] | undefined;

function first(value: QueryValue): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** Reads a shared link, dropping invalid or duplicate domains and anything past MAX_PEERS. */
export function selectionFromQuery(query: Record<string, QueryValue>): Selection {
  const company = normalizeDomain(first(query.company));
  const peers: string[] = [];
  for (const raw of first(query.peers).split(',')) {
    const domain = normalizeDomain(raw);
    if (domain && domain !== company && !peers.includes(domain) && peers.length < MAX_PEERS) peers.push(domain);
  }
  return { company, peers };
}
