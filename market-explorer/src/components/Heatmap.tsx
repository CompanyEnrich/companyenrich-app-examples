'use client';

import { useState } from 'react';
import { stableStringify } from '@/lib/cache';
import {
  DIMENSION_LABELS,
  GRID_CONCURRENCY,
  GRID_DIMENSIONS,
  MAX_AXIS_VALUES,
  defaultAxisValues,
  dimensionOptions,
  sortSegments,
  type AxisSpec,
  type GridDimension,
} from '@/lib/grid';
import { compactNumber, heatLegend, heatLevel } from '@/lib/heat';
import { countryName, type CompanyFilter } from '@/lib/options';
import type { GridResponse } from '@/lib/responses';
import { errorMessage, postJson } from './api';
import { Autocomplete } from './Autocomplete';
import { ChipList, ErrorNote, Help, Panel, ToggleGroup, formatNumber, inputClass, primaryButton } from './ui';

interface Computed {
  key: string;
  result: GridResponse;
  rows: AxisSpec;
  columns: AxisSpec;
}

export function Heatmap({
  filter,
  onApply,
}: {
  filter: CompanyFilter;
  onApply: (segments: { dimension: GridDimension; value: string }[]) => void;
}) {
  const [rows, setRows] = useState<AxisSpec>(() => ({ dimension: 'country', values: defaultAxisValues('country', filter) }));
  const [columns, setColumns] = useState<AxisSpec>(() => ({
    dimension: 'employees',
    values: defaultAxisValues('employees', filter).slice(0, 5),
  }));
  const [computed, setComputed] = useState<Computed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requests = rows.values.length * columns.values.length;
  const requestKey = stableStringify({ filter, rows, columns });
  const stale = computed !== null && computed.key !== requestKey;

  const changeDimension = (axis: 'rows' | 'columns', dimension: GridDimension) => {
    const next = { dimension, values: defaultAxisValues(dimension, filter) };
    if (axis === 'rows') setRows(next);
    else setColumns(next);
  };

  const compute = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await postJson<GridResponse>('/api/grid', { filter, rows, columns });
      setComputed({ key: requestKey, result, rows, columns });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Panel
      title="Segment heatmap"
      description="Split the market by two dimensions. Each cell is one free count: your filters, with that row and column segment. A segment replaces any filter on the same field."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <AxisEditor label="Rows" axis={rows} other={columns.dimension} onDimension={(d) => changeDimension('rows', d)} onValues={(values) => setRows({ ...rows, values })} />
        <AxisEditor
          label="Columns"
          axis={columns}
          other={rows.dimension}
          onDimension={(d) => changeDimension('columns', d)}
          onValues={(values) => setColumns({ ...columns, values })}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className={primaryButton} onClick={compute} disabled={loading || requests === 0}>
          {loading ? 'Counting…' : computed ? 'Recompute heatmap' : 'Compute heatmap'}
        </button>
        <p className="text-sm text-ink-2">
          This runs {requests} free count request{requests === 1 ? '' : 's'} ({rows.values.length} × {columns.values.length}),{' '}
          {GRID_CONCURRENCY} at a time. 0 credits.
        </p>
      </div>

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {stale && !loading && (
        <p className="mt-3 rounded-md bg-warn-soft px-3 py-2 text-sm">
          Filters or axes changed since this grid was computed. Recompute to update it.
        </p>
      )}
      {computed && (
        <HeatGrid
          computed={computed}
          dimmed={stale || loading}
          onApply={(row, column) =>
            onApply([
              { dimension: computed.rows.dimension, value: row },
              { dimension: computed.columns.dimension, value: column },
            ])
          }
        />
      )}
    </Panel>
  );
}

function AxisEditor({
  label,
  axis,
  other,
  onDimension,
  onValues,
}: {
  label: string;
  axis: AxisSpec;
  other: GridDimension;
  onDimension: (dimension: GridDimension) => void;
  onValues: (values: string[]) => void;
}) {
  return (
    <div>
      <label className="text-sm font-medium">
        {label}
        <select
          className={`${inputClass} mt-1`}
          value={axis.dimension}
          onChange={(event) => onDimension(event.target.value as GridDimension)}
        >
          {GRID_DIMENSIONS.map((d) => (
            <option key={d} value={d} disabled={d === other}>
              {DIMENSION_LABELS[d]}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-2">
        {axis.dimension === 'country' ? (
          <>
            <Autocomplete
              kind="countries"
              label={`${label}: add a country`}
              placeholder={axis.values.length >= MAX_AXIS_VALUES ? `Up to ${MAX_AXIS_VALUES} countries` : 'Add a country'}
              disabled={axis.values.length >= MAX_AXIS_VALUES}
              onPick={(s) => !axis.values.includes(String(s.value)) && onValues([...axis.values, String(s.value)])}
            />
            <ChipList
              label={`${label} countries`}
              items={axis.values.map((code) => ({ key: code, label: countryName(code) }))}
              onRemove={(key) => onValues(axis.values.filter((v) => v !== key))}
            />
          </>
        ) : (
          <ToggleGroup
            label={`${label} values`}
            options={dimensionOptions(axis.dimension)}
            selected={axis.values}
            onChange={(values) => onValues(sortSegments(axis.dimension, values))}
            max={MAX_AXIS_VALUES}
          />
        )}
        <Help>
          {axis.values.length} of up to {MAX_AXIS_VALUES} selected.{' '}
          <button type="button" className="text-accent underline" onClick={() => onDimension(axis.dimension)}>
            Reset to my filters
          </button>
        </Help>
      </div>
    </div>
  );
}

function HeatGrid({
  computed,
  dimmed,
  onApply,
}: {
  computed: Computed;
  dimmed: boolean;
  onApply: (row: string, column: string) => void;
}) {
  const { result, rows, columns } = computed;
  const cell = (row: string, column: string) => result.cells.find((c) => c.row === row && c.column === column);
  // Cells show `total` (the segment's size). `count` is capped by the plan, which would flatten big segments.
  const max = Math.max(0, ...result.cells.map((c) => c.total ?? 0));
  const legend = heatLegend(max);
  const failed = result.cells.filter((c) => c.error).length;

  return (
    <div className={`mt-4 transition-opacity ${dimmed ? 'opacity-60' : ''}`}>
      <div className="overflow-x-auto pb-1">
        <table className="border-separate border-spacing-[2px] text-sm">
          <caption className="sr-only">
            Companies by {DIMENSION_LABELS[rows.dimension]} (rows) and {DIMENSION_LABELS[columns.dimension]} (columns).
            Each cell is a button that applies that segment to your filters.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="px-2 py-1 text-left text-xs font-medium text-muted">
                {DIMENSION_LABELS[rows.dimension]} \ {DIMENSION_LABELS[columns.dimension]}
              </th>
              {result.columns.map((c) => (
                <th key={c.value} scope="col" className="min-w-16 px-1 py-1 text-center text-xs font-medium text-ink-2">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.value}>
                <th scope="row" className="max-w-40 truncate px-2 py-1 text-left text-xs font-medium text-ink-2">
                  {r.label}
                </th>
                {result.columns.map((c) => {
                  const data = cell(r.value, c.value);
                  const total = data?.total ?? null;
                  const capped = data?.count != null && total !== null && total > data.count;
                  const level = total === null ? 0 : heatLevel(total, max);
                  const exact = total === null ? 'failed to load' : `${formatNumber(total)} companies`;
                  return (
                    <td key={c.value} className="p-0">
                      <button
                        type="button"
                        disabled={total === null}
                        onClick={() => onApply(r.value, c.value)}
                        aria-label={`${r.label}, ${c.label}: ${exact}. Apply this segment.`}
                        className={`heat-${level} group relative h-11 w-full min-w-16 rounded px-2 text-center text-sm font-semibold tabular-nums transition hover:brightness-110 focus-visible:z-10`}
                      >
                        {total === null ? '!' : compactNumber(total)}
                        <span
                          role="presentation"
                          className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-surface px-2 py-1 text-left text-xs font-normal text-ink shadow-lg group-hover:block group-focus-visible:block"
                        >
                          <strong className="block text-sm">{total === null ? 'Error' : formatNumber(total)}</strong>
                          <span className="block text-ink-2">
                            {r.label} · {c.label}
                          </span>
                          {capped && (
                            <span className="block text-ink-2">Your plan can fetch {formatNumber(data.count ?? 0)}</span>
                          )}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2" aria-label="Color scale">
        <span>Companies (log scale):</span>
        <span className="flex items-center gap-1">
          <span className="heat-0 inline-block h-3 w-5 rounded-sm" aria-hidden /> 0
        </span>
        {legend.map((step) => (
          <span key={step.level} className="flex items-center gap-1">
            <span className={`heat-${step.level} inline-block h-3 w-5 rounded-sm`} aria-hidden />
            {compactNumber(step.from)}+
          </span>
        ))}
      </div>
      <Help>
        Click a cell to apply that segment to your filters. {result.requests} free counts ran for this grid
        {failed ? `; ${failed} failed and show “!”` : ''}.
      </Help>
    </div>
  );
}
