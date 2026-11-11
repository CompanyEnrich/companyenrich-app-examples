import type { RouteDecision } from '@/lib/route';

const OUTCOME: Record<string, { label: string; style: string }> = {
  fired: { label: 'Fired', style: 'bg-emerald-100 text-emerald-800' },
  shadowed: { label: 'Also matches, earlier rule won', style: 'bg-slate-100 text-slate-600' },
  'no-match': { label: 'No match', style: 'bg-white text-slate-500 ring-1 ring-inset ring-slate-200' },
};

/** Every routing rule in order, with each condition's expected and actual value. */
export function RuleList({ route }: { route: RouteDecision }) {
  return (
    <div className="space-y-2">
      <ol className="space-y-2">
        {route.rules.map((rule, index) => {
          const outcome = OUTCOME[rule.outcome] ?? OUTCOME['no-match']!;
          return (
            <li key={rule.name} className={`rounded-md border p-3 ${rule.outcome === 'fired' ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200'}`}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="tabular-nums text-slate-400">{index + 1}.</span>
                <span className="font-medium">{rule.name}</span>
                <span className="text-slate-500">→ {rule.team}</span>
                <span className={`ml-auto rounded px-1.5 py-0.5 text-xs ${outcome.style}`}>{outcome.label}</span>
              </div>
              {rule.checks.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">No conditions: matches every lead.</p>
              ) : (
                <ul className="mt-1 space-y-0.5 text-xs">
                  {rule.checks.map((check) => (
                    <li key={check.field} className={check.pass ? 'text-emerald-700' : 'text-rose-700'}>
                      <span aria-hidden>{check.pass ? '✓' : '✗'}</span> {check.field}: {check.actual}{' '}
                      <span className="text-slate-500">(wants {check.expected})</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-slate-600">
        {route.reason}: <span className="font-medium text-slate-900">{route.teamLabel}</span>
      </p>
    </div>
  );
}
