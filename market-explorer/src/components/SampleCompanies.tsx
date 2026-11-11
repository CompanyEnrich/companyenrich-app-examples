'use client';

import { useEffect, useRef, useState } from 'react';
import { stableStringify } from '@/lib/cache';
import { MAX_SAMPLE_PAGE_SIZE, searchCredits } from '@/lib/cost';
import type { CompanyFilter } from '@/lib/options';
import type { PreviewResponse, SampleCompany, SearchResponse } from '@/lib/responses';
import { errorMessage, isAbort, postJson, useRemote } from './api';
import { ErrorNote, Help, Panel, formatNumber, inputClass, primaryButton, secondaryButton } from './ui';

const PAGE_SIZES = [3, 5, MAX_SAMPLE_PAGE_SIZE];

export function SampleCompanies({
  filter,
  previewFilter,
  previews,
  matches,
}: {
  /** The filter as it is right now. The paid plan is always built from this. */
  filter: CompanyFilter;
  /** The debounced filter, so the free preview does not refetch on every keystroke. */
  previewFilter: CompanyFilter;
  /** From `/api/capabilities`; null while loading or when it failed. */
  previews: boolean | null;
  /** Free count for `filter`, or null while it is being recounted. */
  matches: number | null;
}) {
  const [previewOn, setPreviewOn] = useState(false);
  const [showPaid, setShowPaid] = useState(false);
  const previewKey = stableStringify(previewFilter);
  const preview = useRemote(previews && previewOn ? previewKey : null, (signal) =>
    postJson<PreviewResponse>('/api/preview', { filter: previewFilter }, signal),
  );
  const refused = preview.data?.available === false ? preview.data.reason : null;
  const previewPath = previews === true && refused === null;

  return (
    <Panel
      title="Sample companies"
      description={
        previewPath
          ? 'A free preview of up to 25 matches: name, logo and industry.'
          : 'A paid search returns full records. It always asks before spending credits.'
      }
    >
      {previews === null && <p className="text-sm text-muted">Checking whether your plan includes free previews…</p>}

      {previewPath && !previewOn && (
        <button type="button" className={primaryButton} onClick={() => setPreviewOn(true)}>
          Show matching companies (free)
        </button>
      )}

      {previewPath && previewOn && (
        <div className={preview.loading ? 'opacity-60' : ''}>
          {preview.error && <ErrorNote>{preview.error}</ErrorNote>}
          {preview.data?.available && (
            <>
              <p className="mb-2 text-sm text-ink-2" aria-live="polite">
                Showing {preview.data.items.length} of {formatNumber(preview.data.total)}. Updates with your filters.
              </p>
              <CompanyList items={preview.data.items} />
            </>
          )}
        </div>
      )}

      {refused && (
        <p className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-sm">
          Free preview unavailable: {refused} You can still fetch a small paid sample.
        </p>
      )}

      {previews !== null && (
        <div className="mt-3">
          {previewPath && !showPaid ? (
            <button type="button" className="text-sm text-accent underline" onClick={() => setShowPaid(true)}>
              Need domains and locations? Fetch full records (paid)
            </button>
          ) : (
            // Keyed by the filter: any change discards an open confirmation and old results.
            <PaidSample key={stableStringify(filter)} filter={filter} matches={matches} />
          )}
        </div>
      )}
    </Panel>
  );
}

function PaidSample({ filter, matches }: { filter: CompanyFilter; matches: number | null }) {
  const [pageSize, setPageSize] = useState(MAX_SAMPLE_PAGE_SIZE);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const request = useRef<AbortController | null>(null);
  // The most it can cost; the server re-checks the count and bills only what it returns.
  const credits = searchCredits('filter', pageSize);

  // A response that arrives after the filter changed (this component is keyed by it) is dropped.
  useEffect(() => () => request.current?.abort(), []);

  const run = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await postJson<SearchResponse>('/api/search', { filter, pageSize, confirm: true }, controller.signal);
      if (controller.signal.aborted) return;
      setResult(response);
      setConfirming(false);
    } catch (err) {
      if (!isAbort(err) && !controller.signal.aborted) setError(errorMessage(err));
    } finally {
      if (request.current === controller) setLoading(false);
    }
  };

  if (matches === 0) return <p className="text-sm text-muted">Nothing matches these filters, so there is nothing to fetch.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          Companies to fetch
          <select
            className={`${inputClass} mt-1 w-28`}
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setConfirming(false);
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        {!confirming && (
          <button type="button" className={secondaryButton} onClick={() => setConfirming(true)}>
            Fetch {pageSize} sample companies…
          </button>
        )}
      </div>

      {confirming && (
        <div role="alertdialog" aria-labelledby="paid-confirm" className="rounded-md border border-accent bg-accent-soft p-3">
          <p id="paid-confirm" className="text-sm">
            This costs up to <strong>{credits} credits</strong> (1 per company returned; an empty result still costs 1).
            The server checks the free count first and skips the call if nothing matches.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={primaryButton} onClick={run} disabled={loading} autoFocus>
              {loading ? 'Fetching…' : `Confirm and spend up to ${credits} credits`}
            </button>
            <button type="button" className={secondaryButton} onClick={() => setConfirming(false)} disabled={loading}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
      {result && (
        <div aria-live="polite">
          <p className="mb-2 text-sm text-ink-2">
            {result.skipped
              ? 'The free count was 0, so no paid call was made.'
              : `Fetched ${result.items.length} of ${formatNumber(result.matches)} for about ${result.credits} credits.`}
          </p>
          <CompanyList items={result.items} />
        </div>
      )}
      <Help>Paid samples are capped at {MAX_SAMPLE_PAGE_SIZE} companies per request on the server.</Help>
    </div>
  );
}

function CompanyList({ items }: { items: SampleCompany[] }) {
  if (items.length === 0) return <p className="text-sm text-muted">No companies match.</p>;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {items.map((company) => (
        <li key={company.id} className="flex items-center gap-3 rounded-lg border border-line p-2">
          {/* Logos come from the API; a plain img avoids configuring remote image domains. */}
          <img
            src={company.logoUrl}
            alt=""
            width={32}
            height={32}
            loading="lazy"
            className="h-8 w-8 shrink-0 rounded bg-surface-2 object-contain"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{company.name}</p>
            <p className="truncate text-xs text-ink-2">
              {[company.industry, company.country, company.employees && `${company.employees} employees`]
                .filter(Boolean)
                .join(' · ') || 'Industry unknown'}
            </p>
            {company.domain && (
              <a
                href={`https://${company.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate text-xs text-accent underline"
              >
                {company.domain}
              </a>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
