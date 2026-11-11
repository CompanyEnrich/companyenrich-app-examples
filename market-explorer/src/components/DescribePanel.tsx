'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CREDITS_PER_RESULT } from '@/lib/cost';
import { describeInterpretation, interpretationToState } from '@/lib/describe';
import type { FilterState } from '@/lib/filter';
import type { InterpretResponse } from '@/lib/responses';
import { errorMessage, isAbort, postJson } from './api';
import { ChipRow, ErrorNote, Help, Panel, formatNumber, inputClass, primaryButton, secondaryButton } from './ui';

const EXAMPLES = [
  'Series A fintech companies in Germany using Stripe',
  'B2B SaaS companies in the US with 50-200 employees founded after 2018',
  'Series B healthtech startups in Europe',
];

export function DescribePanel({ onUseFilters }: { onUseFilters: (state: FilterState) => void }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<InterpretResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [includeBoosts, setIncludeBoosts] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const interpret = async (text: string) => {
    // A newer request cancels the older one, so a slow answer can never overwrite a newer query.
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setQuery(text);
    setLoading(true);
    setError(null);
    setNotice(null);
    setResult(null);
    try {
      const response = await postJson<InterpretResponse>('/api/interpret', { query: text }, controller.signal);
      if (!controller.signal.aborted) setResult(response);
    } catch (err) {
      if (!controller.signal.aborted && !isAbort(err)) setError(errorMessage(err));
    } finally {
      if (request.current === controller) setLoading(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length >= 3) void interpret(query.trim());
  };

  const chips = result ? describeInterpretation(result.interpretation) : null;
  const hasRankingBoosts = Boolean(result?.interpretation?.boost?.categories?.length || result?.interpretation?.boost?.revenue?.length);

  const useAsFilters = () => {
    if (!result) return;
    const { state, skipped } = interpretationToState(result.interpretation, { includeBoosts });
    onUseFilters(state);
    setNotice(
      `Replaced the builder's filters with the inferred ones.${skipped.length ? ` Not copied: ${skipped.join(', ')}.` : ''}`,
    );
  };

  return (
    <Panel
      title="Describe a market"
      description="Plain English in, filters out. The free count endpoint interprets the text; no LLM runs in this app."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="market-query" className="sr-only">
          Describe the companies you want to count
        </label>
        <input
          id="market-query"
          type="text"
          className={inputClass}
          placeholder={EXAMPLES[0]}
          value={query}
          maxLength={300}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className={`${primaryButton} shrink-0`} disabled={loading || query.trim().length < 3}>
          {loading ? 'Interpreting…' : 'Interpret (free)'}
        </button>
      </form>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
        <span>Try:</span>
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => void interpret(example)}
            className="rounded-full border border-line-strong px-2 py-0.5 hover:bg-surface-2"
          >
            {example}
          </button>
        ))}
      </div>

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {result && chips && (
        <div className="mt-4 space-y-3" aria-live="polite">
          <p className="text-sm">
            <span className="text-2xl font-semibold">{formatNumber(result.count)}</span>{' '}
            <span className="text-ink-2">
              companies match “{result.query}” as a semantic search. Fetching them would cost{' '}
              {CREDITS_PER_RESULT.semantic} credits each.
            </span>
          </p>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-2">Inferred filters (applied)</h3>
            {chips.filters.length ? (
              <ChipRow chips={chips.filters} />
            ) : (
              <p className="text-sm text-muted">None. The API found nothing it could turn into a filter.</p>
            )}
          </div>
          {chips.boosts.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-2">
                Ranking hints (rank higher, do not filter)
              </h3>
              <ChipRow chips={chips.boosts} tone="boost" />
            </div>
          )}
          {chips.skipped.length > 0 && (
            <Help>The builder cannot show: {chips.skipped.join(', ')}.</Help>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={secondaryButton} onClick={useAsFilters} disabled={!chips.filters.length && !includeBoosts}>
              Use as filters
            </button>
            {hasRankingBoosts && (
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" checked={includeBoosts} onChange={(e) => setIncludeBoosts(e.target.checked)} />
                Also turn category and revenue hints into filters
              </label>
            )}
          </div>
          {notice && <p className="text-sm text-ok">{notice}</p>}
          <Help>
            Semantic counts measure the vector-search candidate pool, so they are not directly comparable to the exact
            filter counts below. Words the API cannot map to a field (like “fintech” or “Stripe”) shape the ranking only;
            add them as keywords or technologies to filter on them.
          </Help>
        </div>
      )}
    </Panel>
  );
}
