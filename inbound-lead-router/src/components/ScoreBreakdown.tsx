import type { ScoreResult } from '@/lib/score';

/** One bar per dimension: the track is as long as the weight, the fill is the points earned. */
export function ScoreBreakdown({ score }: { score: ScoreResult }) {
  const heaviest = Math.max(1, ...score.factors.map((factor) => factor.weight));
  return (
    <div className="space-y-3">
      {score.factors.map((factor) => (
        <div key={factor.dimension}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium">{factor.label}</span>
            <span className="tabular-nums text-slate-600">
              {factor.points} / {factor.weight}
            </span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-slate-100" style={{ width: `${(factor.weight / heaviest) * 100}%` }}>
            <div className={`h-2 rounded-full ${barColor(factor.match)}`} style={{ width: `${factor.match * 100}%` }} />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            <span className="text-slate-700">{factor.value}</span> · {factor.reason}
          </p>
        </div>
      ))}
      <div className="flex justify-between border-t border-slate-200 pt-2 text-sm font-semibold">
        <span>Total</span>
        <span className="tabular-nums">
          {score.total} / {score.max}
        </span>
      </div>
    </div>
  );
}

function barColor(match: number): string {
  if (match >= 0.7) return 'bg-emerald-500';
  if (match >= 0.4) return 'bg-amber-400';
  return 'bg-rose-400';
}
