'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_SUGGESTED, MAX_PEERS } from '@/lib/requests';
import { selectionToQuery, type Selection } from '@/lib/share-url';
import { api, RequestError, type BenchmarkEstimate, type BenchmarkRun, type CompanyOption, type SuggestEstimate } from './api';
import { CompanyLogo } from './CompanyLogo';
import { CompanySearch } from './CompanySearch';
import { CostConfirm } from './CostConfirm';
import { Results } from './Results';

interface Peer extends CompanyOption {
  /** Lookalike score when the peer came from "Suggest peers". */
  score: number | null;
}

type RunState =
  | { phase: 'idle' }
  | { phase: 'estimating' }
  | { phase: 'confirm'; estimate: BenchmarkEstimate; note?: string }
  | { phase: 'running' }
  | { phase: 'error'; message: string };

type SuggestState =
  | { phase: 'idle' }
  | { phase: 'counting' }
  | { phase: 'confirm'; estimate: SuggestEstimate; count: number }
  | { phase: 'buying' }
  | { phase: 'done'; message: string }
  | { phase: 'error'; message: string };

function fromDomain(domain: string): CompanyOption {
  return { domain, name: domain, logoUrl: null };
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  const charged = error instanceof RequestError ? error.creditsCharged : 0;
  return charged > 0 ? `${message} ${charged} credit${charged === 1 ? ' was' : 's were'} spent before the error.` : message;
}

/** A failed paid request can still have spent credits; keep the session ledger honest. */
function chargedBy(error: unknown): number {
  return error instanceof RequestError ? error.creditsCharged : 0;
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

export function BenchmarkApp({ initial }: { initial: Selection }) {
  const [company, setCompany] = useState<CompanyOption | null>(initial.company ? fromDomain(initial.company) : null);
  const [peers, setPeers] = useState<Peer[]>(initial.peers.map((domain) => ({ ...fromDomain(domain), score: null })));
  const [run, setRun] = useState<RunState>({ phase: 'idle' });
  const [suggest, setSuggest] = useState<SuggestState>({ phase: 'idle' });
  const [suggestCount, setSuggestCount] = useState(DEFAULT_SUGGESTED);
  const [result, setResult] = useState<{ run: BenchmarkRun; picks: string } | null>(null);
  const [spent, setSpent] = useState(0);
  const started = useRef(false);

  const peerDomains = peers.map((peer) => peer.domain);
  const picks = company ? [company.domain, ...peerDomains].join(',') : '';
  const room = MAX_PEERS - peers.length;
  const count = Math.max(1, Math.min(suggestCount, room));

  // Keep the URL shareable: domains only, never the key. `picks` changes exactly when the selection does.
  useEffect(() => {
    const query = selectionToQuery({ company: company?.domain ?? null, peers: peerDomains });
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  }, [picks]);

  // A shared link: fill in names (free autocomplete), then show the cost. If everything is cached, just run.
  // Runs once; the ref stops React's development double-invoke from estimating twice.
  useEffect(() => {
    if (started.current || !initial.company) return;
    started.current = true;
    void hydrateNames([initial.company, ...initial.peers]);
    if (initial.peers.length > 0) void estimate(true);
  }, []);

  async function hydrateNames(domains: string[]) {
    const found = await Promise.all(
      domains.map(async (domain) => {
        const { items } = await api.autocomplete(domain).catch(() => ({ items: [] as CompanyOption[] }));
        return items.find((item) => item.domain === domain);
      }),
    );
    const byDomain = new Map(found.flatMap((item) => (item ? [[item.domain, item] as const] : [])));
    setCompany((current) => (current && byDomain.get(current.domain)) || current);
    setPeers((current) => current.map((peer) => ({ ...peer, ...byDomain.get(peer.domain), score: peer.score })));
  }

  // Each async flow remembers the generation it started in and drops a late
  // answer if the inputs changed since, so an old estimate can never be confirmed.
  const runGeneration = useRef(0);
  const suggestGeneration = useRef(0);

  function invalidateRun() {
    runGeneration.current += 1;
    setRun({ phase: 'idle' });
  }

  function invalidateSuggest() {
    suggestGeneration.current += 1;
    setSuggest({ phase: 'idle' });
  }

  function picksChanged() {
    invalidateRun();
    invalidateSuggest();
  }

  function chooseCompany(option: CompanyOption) {
    setCompany(option);
    setPeers((current) => current.filter((peer) => peer.domain !== option.domain));
    picksChanged();
  }

  function addPeer(option: CompanyOption) {
    if (peers.length >= MAX_PEERS || peers.some((peer) => peer.domain === option.domain)) return;
    setPeers((current) => [...current, { ...option, score: null }]);
    picksChanged();
  }

  function removePeer(domain: string) {
    setPeers((current) => current.filter((peer) => peer.domain !== domain));
    picksChanged();
  }

  async function checkSuggestions() {
    if (!company) return;
    const generation = ++suggestGeneration.current;
    setSuggest({ phase: 'counting' });
    try {
      const { estimate } = await api.estimateSuggestions({ company: company.domain, peers: peerDomains, count });
      if (generation !== suggestGeneration.current) return;
      if (estimate.pageSize === 0) {
        setSuggest({ phase: 'done', message: `CompanyEnrich found no more lookalikes of ${company.domain}. Nothing was spent.` });
      } else if (estimate.credits === 0) {
        await buySuggestions(estimate, count);
      } else {
        setSuggest({ phase: 'confirm', estimate, count });
      }
    } catch (error) {
      if (generation === suggestGeneration.current) setSuggest({ phase: 'error', message: messageOf(error) });
    }
  }

  /** Picks are locked while this runs, so the answer always matches the current picks. */
  async function buySuggestions(estimate: SuggestEstimate, size: number) {
    if (!company) return;
    setSuggest({ phase: 'buying' });
    try {
      const response = await api.suggest({ company: company.domain, peers: peerDomains, count: size, maxCredits: estimate.credits });
      setSpent((total) => total + response.creditsCharged);
      const fresh = response.peers.filter((peer) => peer.domain !== company.domain && !peerDomains.includes(peer.domain));
      setPeers((current) => [...current, ...fresh].slice(0, MAX_PEERS));
      invalidateRun();
      const cost = response.cached ? 'from cache, free' : plural(response.creditsCharged, 'credit');
      setSuggest({ phase: 'done', message: `Added ${plural(fresh.length, 'lookalike peer')} in the API's ranking order (${cost}).` });
    } catch (error) {
      setSpent((total) => total + chargedBy(error));
      setSuggest({ phase: 'error', message: messageOf(error) });
    }
  }

  async function estimate(runIfFree: boolean, note?: string) {
    if (!company || peers.length === 0) return;
    const generation = ++runGeneration.current;
    setRun({ phase: 'estimating' });
    try {
      const { estimate } = await api.estimateBenchmark({ company: company.domain, peers: peerDomains });
      if (generation !== runGeneration.current) return;
      if (runIfFree && estimate.credits === 0) await execute(0);
      else setRun({ phase: 'confirm', estimate, note });
    } catch (error) {
      if (generation === runGeneration.current) setRun({ phase: 'error', message: messageOf(error) });
    }
  }

  /** Picks are locked while this runs, so the result is for the picks on screen. */
  async function execute(maxCredits: number) {
    if (!company) return;
    setRun({ phase: 'running' });
    try {
      const response = await api.benchmark({ company: company.domain, peers: peerDomains, maxCredits });
      setSpent((total) => total + response.creditsCharged);
      setResult({ run: response, picks });
      setRun({ phase: 'idle' });
    } catch (error) {
      setSpent((total) => total + chargedBy(error));
      // 409: the cost went up since it was shown (for example, the cache expired). Show the new cost.
      if (error instanceof RequestError && error.status === 409) await estimate(false, error.message);
      else setRun({ phase: 'error', message: messageOf(error) });
    }
  }

  const scores = Object.fromEntries(peers.map((peer) => [peer.domain, peer.score]));
  const busy = run.phase === 'estimating' || run.phase === 'running';
  // While credits are being spent, the picks that define the purchase cannot change.
  const locked = run.phase === 'running' || suggest.phase === 'buying';

  return (
    <div>
      <div className="grid gap-4">
        <Step number={1} title="Your company">
          {company ? (
            <div className="flex flex-wrap items-center gap-3">
              <CompanyChip company={company} />
              <button
                type="button"
                onClick={() => {
                  setCompany(null);
                  picksChanged();
                }}
                disabled={locked}
                className="text-sm text-ink-2 underline underline-offset-2 disabled:opacity-50"
              >
                Change
              </button>
            </div>
          ) : (
            <CompanySearch
              label="Your company's domain"
              placeholder="Type a domain, e.g. posthog.com"
              exclude={peerDomains}
              onSelect={chooseCompany}
            />
          )}
        </Step>

        <Step number={2} title={`Peers (${peers.length} of ${MAX_PEERS})`} disabled={!company}>
          {peers.length > 0 && (
            <ul className="mb-3 flex flex-wrap gap-2">
              {peers.map((peer) => (
                <li key={peer.domain}>
                  <CompanyChip company={peer} score={peer.score} onRemove={locked ? undefined : () => removePeer(peer.domain)} />
                </li>
              ))}
            </ul>
          )}

          {room > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="mb-2 text-sm text-ink-2">Add peers by hand (free autocomplete).</p>
                <CompanySearch
                  label="Add a peer by domain"
                  placeholder="Add a peer domain"
                  exclude={company ? [company.domain, ...peerDomains] : peerDomains}
                  disabled={!company || locked}
                  onSelect={addPeer}
                />
              </div>
              <div>
                <p className="mb-2 text-sm text-ink-2">Or let lookalike search suggest them (5 credits each).</p>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    How many
                    <select
                      value={count}
                      onChange={(event) => {
                        setSuggestCount(Number(event.target.value));
                        invalidateSuggest();
                      }}
                      disabled={!company || locked}
                      className="rounded-lg border border-line bg-surface px-2 py-1.5"
                    >
                      {Array.from({ length: room }, (_, index) => index + 1).map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={checkSuggestions}
                    disabled={!company || locked || suggest.phase === 'counting'}
                    className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                  >
                    {suggest.phase === 'counting' ? 'Checking…' : 'Suggest peers'}
                  </button>
                </div>
                {suggest.phase === 'confirm' && (
                  <CostConfirm
                    confirmLabel={`Add ${suggest.estimate.pageSize} for ${suggest.estimate.credits} credits`}
                    busy={false}
                    onConfirm={() => buySuggestions(suggest.estimate, suggest.count)}
                    onCancel={invalidateSuggest}
                  >
                    The free count found {suggest.estimate.available.toLocaleString('en-US')} lookalikes of{' '}
                    {company?.domain}. Adding the top {suggest.estimate.pageSize} costs{' '}
                    <strong>{suggest.estimate.credits} credits</strong> (5 per company).
                    <BudgetNote credits={suggest.estimate.credits} remaining={suggest.estimate.budgetRemaining} />
                  </CostConfirm>
                )}
                {suggest.phase === 'buying' && <p className="mt-2 text-sm text-ink-2">Finding lookalikes…</p>}
                {suggest.phase === 'done' && <p className="mt-2 text-sm text-ink-2">{suggest.message}</p>}
                {suggest.phase === 'error' && (
                  <p role="alert" className="mt-2 text-sm text-critical">
                    {suggest.message}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink-2">That is the maximum of {MAX_PEERS} peers. Remove one to add another.</p>
          )}
        </Step>

        <Step number={3} title="Benchmark" disabled={!company || peers.length === 0}>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => estimate(false)}
              disabled={!company || peers.length === 0 || busy || run.phase === 'confirm'}
              className="rounded-lg bg-accent-strong px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {run.phase === 'running' ? 'Fetching workforce data…' : `Compare ${plural(peers.length + 1, 'company', 'companies')}`}
            </button>
            <span className="text-sm text-ink-2">Spent in this session: {plural(spent, 'credit')}</span>
          </div>
          {run.phase === 'confirm' && (
            <CostConfirm
              confirmLabel={run.estimate.credits === 0 ? 'Run (free)' : `Spend up to ${plural(run.estimate.credits, 'credit')}`}
              busy={false}
              onConfirm={() => execute(run.estimate.credits)}
              onCancel={invalidateRun}
            >
              {run.note && <p className="mb-2">{run.note}</p>}
              Workforce data for {plural(run.estimate.companies, 'company', 'companies')} costs up to{' '}
              <strong>{plural(run.estimate.credits, 'credit')}</strong> (1 per company, latest 12 months).
              {run.estimate.cached > 0 && ` ${run.estimate.cached} cached from the last hour, free.`} Companies without
              workforce data cost nothing.
              <BudgetNote credits={run.estimate.credits} remaining={run.estimate.budgetRemaining} />
            </CostConfirm>
          )}
          {run.phase === 'error' && (
            <p role="alert" className="mt-3 text-sm text-critical">
              {run.message}
            </p>
          )}
        </Step>
      </div>

      {result && <Results run={result.run} scores={scores} stale={result.picks !== picks} />}
    </div>
  );
}

/** Shown only when the server's MAX_CREDITS budget cannot cover the purchase; the server would refuse it. */
function BudgetNote({ credits, remaining }: { credits: number; remaining: number }) {
  if (credits <= remaining) return null;
  return (
    <p className="mt-2 text-critical">
      This server may spend only {remaining} more credits (MAX_CREDITS), so it will refuse this. Raise MAX_CREDITS and
      restart the server.
    </p>
  );
}

function Step({
  number,
  title,
  disabled,
  children,
}: {
  number: number;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`rounded-xl border border-line bg-surface p-4 sm:p-6 ${disabled ? 'opacity-60' : ''}`}>
      <h2 className="mb-3 flex items-center gap-2 font-semibold">
        <span aria-hidden className="flex size-6 items-center justify-center rounded-full bg-accent-wash text-sm text-ink">
          {number}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function CompanyChip({ company, score, onRemove }: { company: CompanyOption; score?: number | null; onRemove?: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-page py-1 pr-2 pl-1.5 text-sm">
      <CompanyLogo src={company.logoUrl} />
      <span className="truncate font-medium">{company.name}</span>
      {company.name !== company.domain && <span className="hidden truncate text-ink-2 sm:inline">{company.domain}</span>}
      {score != null && <span className="text-xs text-ink-2 tabular-nums">score {score.toFixed(2)}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${company.name}`}
          className="ml-0.5 rounded-full px-1 text-ink-2 hover:text-ink"
        >
          ×
        </button>
      )}
    </span>
  );
}
