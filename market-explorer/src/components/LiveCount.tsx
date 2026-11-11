'use client';

import { CREDITS_PER_RESULT, costLadder } from '@/lib/cost';
import type { Chip } from '@/lib/describe';
import type { CountResponse } from '@/lib/responses';
import type { Remote } from './api';
import { ChipRow, ErrorNote, formatNumber } from './ui';

export function LiveCount({ remote, chips }: { remote: Remote<CountResponse>; chips: Chip[] }) {
  const { data, error, loading } = remote;
  const capped = data !== null && data.total > data.count;
  return (
    <section
      aria-labelledby="live-count-heading"
      className="rounded-xl border border-line bg-surface p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="live-count-heading" className="text-base font-semibold">
          Matching companies
        </h2>
        <span aria-live="polite" className="text-xs text-muted">
          {loading ? 'Updating…' : 'Free count, updates as you edit'}
        </span>
      </div>

      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className={`mt-2 transition-opacity ${loading ? 'opacity-60' : ''}`}>
        <p className="text-5xl font-semibold tracking-tight" aria-live="polite" aria-atomic="true">
          {data ? formatNumber(data.total) : '…'}
          <span className="sr-only"> companies</span>
        </p>
        {data && (
          <p className="mt-1 text-sm text-ink-2">
            {capped
              ? `Total market (total). Your plan can fetch the first ${formatNumber(data.count)} of them (count).`
              : 'Exact count from the free count endpoint (count and total agree).'}
          </p>
        )}

        {data && data.count > 0 && (
          <div className="mt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-2">
              Cost to fetch them (filter search, {CREDITS_PER_RESULT.filter} credit per company)
            </h3>
            <table className="mt-1 text-sm">
              <tbody>
                {costLadder('filter', data.count).map((line) => (
                  <tr key={line.results}>
                    <td className="pr-4 text-ink-2 tabular-nums">
                      {line.results === data.count ? `All ${formatNumber(line.results)}` : `First ${formatNumber(line.results)}`}
                    </td>
                    <td className="font-medium tabular-nums">{formatNumber(line.credits)} credits</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-muted">
              Semantic search costs {CREDITS_PER_RESULT.semantic} per company; each paid expansion adds 1.
            </p>
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-line pt-3">
        {chips.length ? (
          <ChipRow chips={chips} />
        ) : (
          <p className="text-sm text-muted">No filters yet: this counts every company in the dataset.</p>
        )}
      </div>
    </section>
  );
}
