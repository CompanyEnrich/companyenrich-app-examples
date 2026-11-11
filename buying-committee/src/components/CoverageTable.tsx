import { coverageMatrix } from '@/lib/matrix';
import { BAND_LABELS } from '@/lib/size';
import type { CoveragePlan } from '@/lib/types';

/** Step 1: accounts x roles with free people counts. Single-threaded accounts are highlighted. */
export function CoverageTable({ plan }: { plan: CoveragePlan }) {
  const matrix = coverageMatrix(plan);
  const roleLabels = new Map(plan.accounts.flatMap(({ roles }) => roles.map(({ role }) => [role.key, role.label] as const)));

  return (
    <div>
      <div className="overflow-x-auto rounded-md border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <table className="w-full text-sm">
          <thead className="bg-stone-100 text-left dark:bg-stone-800">
            <tr>
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium">Employees</th>
              {matrix.columns.map((column) => (
                <th key={column.key} className="px-3 py-2 text-right font-medium" title={roleLabels.get(column.key)}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map(({ account, cells, singleThreaded }) => (
              <tr key={account.domain} className={`border-t border-stone-100 dark:border-stone-800 ${singleThreaded ? 'bg-amber-50 dark:bg-amber-950/40' : ''}`}>
                <td className="px-3 py-2">
                  <div className="font-medium">{account.name}</div>
                  <div className="text-xs text-stone-500">{account.domain}</div>
                  {singleThreaded && (
                    <span className="mt-1 inline-block rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-800 dark:text-amber-100">
                      Single-threaded
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-stone-600 dark:text-stone-400">{account.employees ?? 'unknown'}</td>
                {cells.map((cell, index) => (
                  <td
                    key={matrix.columns[index]!.key}
                    className={`px-3 py-2 text-right tabular-nums ${cell === 0 ? 'font-medium text-red-700 dark:text-red-400' : ''} ${cell === null ? 'text-stone-300 dark:text-stone-600' : ''}`}
                  >
                    {cell === null ? '-' : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-stone-500">
        Counts are people matching each role&apos;s department, seniority and title filters (free). 0 = gap. &quot;-&quot; = not part of the
        committee at that size. Single-threaded = at most one role has anyone.
      </p>
      <ul className="mt-3 space-y-1 text-sm text-stone-600 dark:text-stone-400">
        {plan.accounts.map(({ account, adaptation }) => (
          <li key={account.domain}>
            <span className="font-medium text-stone-800 dark:text-stone-200">{account.name}</span> ({BAND_LABELS[account.band]}):{' '}
            {adaptation.join(' ')}
          </li>
        ))}
        {plan.unresolved.map(({ domain, reason }) => (
          <li key={domain} className="text-red-700 dark:text-red-400">
            Skipped {domain}: {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
