'use client';

import { useState } from 'react';
import { departmentsForGrowth, departmentsForMix, type Benchmark } from '@/lib/benchmark';
import { formatGrowth, formatMonth, formatShare } from '@/lib/format';
import { MIN_GROWTH_BASE, type Growth } from '@/lib/growth';
import { linearScale } from '@/lib/scale';
import type { BenchmarkRun } from './api';
import { CompaniesTable } from './CompaniesTable';
import { DotPlot, type DotPlotRow } from './DotPlot';

interface Props {
  run: BenchmarkRun;
  scores: Record<string, number | null>;
  /** The picks changed after this run; the numbers are for the previous picks. */
  stale: boolean;
}

/** Growth past +200% is drawn at the axis edge so one tiny team does not flatten every other row. */
const GROWTH_LIMITS: [number, number] = [-1, 2];

function subjectNote(growth: Growth | null): string | undefined {
  switch (growth?.kind) {
    case 'small-base':
      return `Under ${MIN_GROWTH_BASE} people at the start`;
    case 'zero-base':
      return 'No one at the start';
    case 'no-history':
      return 'No history at the start';
    default:
      return undefined;
  }
}

function values(rows: DotPlotRow[]): number[] {
  return rows.flatMap((row) => [row.subject, row.median, ...row.peers.map((peer) => peer.value)]).filter((value) => value !== null);
}

export function Results({ run, scores, stale }: Props) {
  const { benchmark, insights } = run;
  const { subject } = benchmark;
  const logos = Object.fromEntries(run.companies.map((company) => [company.domain, company.logoUrl]));
  const rows = [...(subject ? [subject] : []), ...benchmark.peers];
  const comparable = subject !== null && benchmark.peers.length > 0;
  const period = benchmark.window;
  const since = period ? formatMonth(period.start) : 'the window start';

  return (
    <section aria-label="Benchmark results" className={`mt-10 space-y-6 transition-opacity ${stale ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">
          {subject?.name ?? run.companies[0]?.name} vs {benchmark.peers.length} peer{benchmark.peers.length === 1 ? '' : 's'}
        </h2>
        <p className="text-sm text-ink-2">
          {period && `${formatMonth(period.start)} to ${formatMonth(period.end)} · `}
          {run.creditsCharged} credit{run.creditsCharged === 1 ? '' : 's'} charged
          {run.cached > 0 && `, ${run.cached} from cache`}
        </p>
      </div>
      {stale && <p className="text-sm text-ink-2">Your picks changed since this run. Run the benchmark again to update.</p>}

      <div className="rounded-xl border border-line bg-surface p-4 sm:p-6">
        <h3 className="font-semibold">Insights</h3>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          {insights.map((insight) => (
            <li key={insight}>{insight}</li>
          ))}
        </ul>
      </div>

      {comparable && <MixChart benchmark={benchmark} />}
      {comparable && <GrowthChart benchmark={benchmark} since={since} />}

      {rows.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-4 sm:p-6">
          <h3 className="font-semibold">All companies</h3>
          <p className="mt-1 text-sm text-ink-2">
            Observed headcount, growth since {since}, and each department’s share of observed headcount. Select a
            column to sort.
          </p>
          <div className="mt-3">
            <CompaniesTable rows={rows} departments={departmentsForMix(benchmark)} logos={logos} scores={scores} />
          </div>
          {rows.some((row) => row.growth.overall.kind === 'small-base') && (
            <p className="mt-2 text-xs text-ink-2">* Fewer than {MIN_GROWTH_BASE} people at the window start: shown, not compared.</p>
          )}
        </div>
      )}

      {benchmark.excluded.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-4 sm:p-6">
          <h3 className="font-semibold">Excluded</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {benchmark.excluded.map((company) => (
              <li key={company.domain}>
                <span className="font-medium">{company.domain}</span>
                {company.role === 'subject' && ' (your company)'}
                <span className="text-ink-2">: {company.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ShareLink />
    </section>
  );
}

function MixChart({ benchmark }: { benchmark: Benchmark }) {
  const rows: DotPlotRow[] = [
    ...departmentsForMix(benchmark).map((department) => ({
      key: department.key,
      label: department.label,
      subject: department.share.subject,
      median: department.share.peerMedian,
      peers: department.share.peers,
    })),
    {
      key: 'unclassified',
      label: 'Unclassified',
      subject: benchmark.unclassified.subject,
      median: benchmark.unclassified.peerMedian,
      peers: benchmark.unclassified.peers,
      divider: true,
    },
  ];
  return (
    <DotPlot
      title="Department mix"
      description="Each department’s share of observed headcount. Unclassified is headcount whose job title matched no department. Departments under 1% everywhere are hidden."
      subjectName={benchmark.subject?.name ?? ''}
      rows={rows}
      scale={linearScale(values(rows), { limits: [0, 1] })}
      format={formatShare}
    />
  );
}

function GrowthChart({ benchmark, since }: { benchmark: Benchmark; since: string }) {
  const rows: DotPlotRow[] = [
    {
      key: 'overall',
      label: 'All observed',
      subject: benchmark.growth.subject,
      subjectNote: subjectNote(benchmark.growth.subjectGrowth),
      median: benchmark.growth.peerMedian,
      peers: benchmark.growth.peers,
    },
    ...departmentsForGrowth(benchmark).map((department) => ({
      key: department.key,
      label: department.label,
      subject: department.growth.subject,
      subjectNote: subjectNote(department.growth.subjectGrowth),
      median: department.growth.peerMedian,
      peers: department.growth.peers,
    })),
  ];
  return (
    <DotPlot
      title={`Growth since ${since}`}
      description={`Change in observed headcount over the 12-month window, overall and per department. Teams with fewer than ${MIN_GROWTH_BASE} people at the start are left out (n/a): their percentages swing too much to compare.`}
      subjectName={benchmark.subject?.name ?? ''}
      rows={rows}
      scale={linearScale(values(rows), { limits: GROWTH_LIMITS })}
      format={formatGrowth}
      zeroLine
    />
  );
}

function ShareLink() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(window.location.href);
          setCopied(true);
        }}
        className="rounded-lg border border-line bg-surface px-3 py-1.5 text-ink"
      >
        {copied ? 'Link copied' : 'Copy share link'}
      </button>
      The link holds only the domains. Opening it shows the cost before anything is spent.
    </div>
  );
}
