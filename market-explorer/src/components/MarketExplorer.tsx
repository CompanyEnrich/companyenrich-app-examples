'use client';

import { useMemo, useState } from 'react';
import { stableStringify } from '@/lib/cache';
import { describeState } from '@/lib/describe';
import { emptyFilterState, toApiFilter, type FilterState } from '@/lib/filter';
import { applySegmentToState } from '@/lib/grid';
import type { CapabilitiesResponse, CountResponse } from '@/lib/responses';
import { getJson, postJson, useDebouncedValue, useRemote } from './api';
import { DescribePanel } from './DescribePanel';
import { ExportPanel } from './ExportPanel';
import { FilterBuilder } from './FilterBuilder';
import { Heatmap } from './Heatmap';
import { LiveCount } from './LiveCount';
import { SampleCompanies } from './SampleCompanies';
import { ErrorNote } from './ui';

const COUNT_DEBOUNCE_MS = 400;

export function MarketExplorer() {
  const [state, setState] = useState<FilterState>(emptyFilterState);
  const filter = useMemo(() => toApiFilter(state), [state]);
  const filterKey = stableStringify(filter);

  // Live count: wait until edits pause, then one free count request.
  const debouncedKey = useDebouncedValue(filterKey, COUNT_DEBOUNCE_MS);
  const debouncedFilter = useMemo(() => JSON.parse(debouncedKey) as typeof filter, [debouncedKey]);
  const count = useRemote(debouncedKey, (signal) => postJson<CountResponse>('/api/count', { filter: debouncedFilter }, signal));

  // The count describes the filter on screen only once the debounce settled and the request finished.
  const countIsCurrent = debouncedKey === filterKey && !count.loading;

  const capabilities = useRemote('capabilities', (signal) => getJson<CapabilitiesResponse>('/api/capabilities', signal));

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Market Explorer</h1>
        <p className="mt-1 max-w-3xl text-ink-2">
          Size a B2B market for free. Describe it or build filters, and get exact company counts, a segment heatmap and
          sample companies from the{' '}
          <a className="text-accent underline" href="https://docs.companyenrich.com" target="_blank" rel="noopener noreferrer">
            CompanyEnrich API
          </a>
          . Counting is free; anything that costs credits asks first.
        </p>
      </header>

      {capabilities.error && (
        <div className="mb-4">
          <ErrorNote>{capabilities.error}</ErrorNote>
        </div>
      )}

      <div className="mb-6">
        <DescribePanel onUseFilters={(next) => setState(next)} />
      </div>

      {/* On phones the count comes first; on wide screens the filters take the left column. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:grid-rows-[auto_1fr]">
        <div className="min-w-0 lg:col-start-2 lg:row-start-1">
          <LiveCount remote={count} chips={describeState(state)} />
        </div>
        <div className="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <FilterBuilder state={state} onChange={setState} onClear={() => setState(emptyFilterState())} />
        </div>
        <div className="min-w-0 space-y-6 lg:col-start-2 lg:row-start-2">
          <Heatmap
            filter={filter}
            onApply={(segments) =>
              setState((previous) =>
                segments.reduce((next, { dimension, value }) => applySegmentToState(next, dimension, value), previous),
              )
            }
          />
          <SampleCompanies
            filter={filter}
            previewFilter={debouncedFilter}
            previews={capabilities.data?.previews ?? null}
            matches={countIsCurrent ? (count.data?.count ?? null) : null}
          />
          <ExportPanel filter={filter} />
        </div>
      </div>

      <footer className="mt-10 text-xs text-muted">
        Built on the free count, preview and autocomplete endpoints of the CompanyEnrich v2 API. Get a key at{' '}
        <a className="underline" href="https://companyenrich.com/dashboard" target="_blank" rel="noopener noreferrer">
          companyenrich.com/dashboard
        </a>
        .
      </footer>
    </div>
  );
}
