import type { Tier } from '@/lib/enums';

const STYLES: Record<Tier, string> = {
  A: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  B: 'bg-sky-100 text-sky-800 ring-sky-200',
  C: 'bg-amber-100 text-amber-800 ring-amber-200',
  unqualified: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function TierBadge({ tier }: { tier: Tier | null }) {
  const style = tier ? STYLES[tier] : STYLES.unqualified;
  const label = tier === null ? 'Not scored' : tier === 'unqualified' ? 'Unqualified' : `Tier ${tier}`;
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${style}`}>{label}</span>;
}
