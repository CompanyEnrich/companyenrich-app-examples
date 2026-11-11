'use client';

import { useState } from 'react';
import type { CompanyRow, DepartmentBenchmark } from '@/lib/benchmark';
import type { DepartmentKey } from '@/lib/departments';
import { formatCount, formatGrowth, formatShare } from '@/lib/format';
import { MIN_GROWTH_BASE, type Growth } from '@/lib/growth';
import { CompanyLogo } from './CompanyLogo';

interface Props {
  rows: CompanyRow[];
  departments: DepartmentBenchmark[];
  logos: Record<string, string | null>;
  scores: Record<string, number | null>;
}

type SortKey = 'picked' | 'name' | 'observed' | 'growth' | 'unclassified' | DepartmentKey;
interface Sort {
  key: SortKey;
  descending: boolean;
}

function growthValue(growth: Growth): number | null {
  return growth.kind === 'measured' || growth.kind === 'small-base' ? growth.rate : null;
}

function growthNote(growth: Growth): string | undefined {
  if (growth.kind === 'small-base') return `Fewer than ${MIN_GROWTH_BASE} at the window start; not compared`;
  if (growth.kind === 'zero-base') return 'No one at the window start';
  if (growth.kind === 'no-history') return 'No history at the window start';
  return undefined;
}

function sortValue(row: CompanyRow, key: SortKey, pickedOrder: number): number | string | null {
  switch (key) {
    case 'picked':
      return pickedOrder;
    case 'name':
      return row.name.toLowerCase();
    case 'observed':
      return row.mix.observed;
    case 'growth':
      return growthValue(row.growth.overall);
    case 'unclassified':
      return row.mix.unclassifiedShare;
    default:
      return row.mix.shares[key];
  }
}

/** Every company with data, sortable by any column. Missing values always sort last. */
export function CompaniesTable({ rows, departments, logos, scores }: Props) {
  const [sort, setSort] = useState<Sort>({ key: 'picked', descending: false });

  const sorted = rows
    .map((row, index) => ({ row, value: sortValue(row, sort.key, index) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) return a.value === null ? (b.value === null ? 0 : 1) : -1;
      const order = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
      return sort.descending ? -order : order;
    })
    .map(({ row }) => row);

  function sortBy(key: SortKey) {
    // Numbers read best biggest-first; names A to Z.
    setSort((current) =>
      current.key === key ? { key, descending: !current.descending } : { key, descending: key !== 'name' && key !== 'picked' },
    );
  }

  function header(key: SortKey, label: string, align: 'left' | 'right' = 'right') {
    const active = sort.key === key;
    return (
      <th
        scope="col"
        aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
        className={`whitespace-nowrap py-2 pr-3 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
      >
        <button type="button" onClick={() => sortBy(key)} className={`hover:text-ink ${active ? 'text-ink' : ''}`}>
          {label}
          <span aria-hidden className="ml-1 inline-block w-2">
            {active ? (sort.descending ? '↓' : '↑') : ''}
          </span>
        </button>
      </th>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-ink-2">
          <tr className="border-b border-line">
            {header('name', 'Company', 'left')}
            {header('observed', 'Observed')}
            {header('growth', 'Growth')}
            {departments.map((department) => header(department.key, department.label))}
            {header('unclassified', 'Unclassified')}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {sorted.map((row) => {
            const rate = growthValue(row.growth.overall);
            const note = growthNote(row.growth.overall);
            const score = scores[row.domain];
            return (
              <tr key={row.domain} className={`border-b border-line last:border-0 ${row.role === 'subject' ? 'bg-accent-wash' : ''}`}>
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <div className="flex items-center gap-2">
                    <CompanyLogo src={logos[row.domain] ?? null} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 whitespace-nowrap font-medium">
                        {row.name}
                        {row.role === 'subject' && (
                          <span className="rounded bg-accent-strong px-1.5 text-xs font-medium text-white">You</span>
                        )}
                      </div>
                      <div className="whitespace-nowrap text-xs text-ink-2">
                        {row.domain}
                        {score != null && ` · lookalike score ${score.toFixed(2)}`}
                      </div>
                    </div>
                  </div>
                </th>
                <td className="py-2 pr-3 text-right">{formatCount(row.mix.observed)}</td>
                <td className={`py-2 pr-3 text-right ${note ? 'text-muted' : ''}`} title={note}>
                  {rate === null ? 'n/a' : formatGrowth(rate)}
                  {note && rate !== null && '*'}
                </td>
                {departments.map((department) => (
                  <td key={department.key} className="py-2 pr-3 text-right">
                    {formatShare(row.mix.shares[department.key])}
                  </td>
                ))}
                <td className="py-2 pr-3 text-right">{formatShare(row.mix.unclassifiedShare)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
