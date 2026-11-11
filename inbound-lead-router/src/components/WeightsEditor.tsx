'use client';

import type { DimensionKey, ScoringConfig } from '@/lib/config';

interface Props {
  scoring: ScoringConfig;
  onChange: (next: ScoringConfig) => void;
  onReset: () => void;
  edited: boolean;
}

/** Sliders for dimension weights and tier minimums. Changes stay in the page until exported. */
export function WeightsEditor({ scoring, onChange, onReset, edited }: Props) {
  const dimensions = Object.keys(scoring.dimensions) as DimensionKey[];
  const max = dimensions.reduce((sum, key) => sum + scoring.dimensions[key].weight, 0);

  function setWeight(key: DimensionKey, weight: number) {
    const next = structuredClone(scoring);
    next.dimensions[key].weight = weight;
    onChange(next);
  }

  function setTier(tier: 'A' | 'B' | 'C', value: number) {
    const next = structuredClone(scoring);
    next.tiers[tier] = value;
    onChange(next);
  }

  function exportJson() {
    const blob = new Blob([`${JSON.stringify(scoring, null, 2)}\n`], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'scoring.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const tiersInOrder = scoring.tiers.A >= scoring.tiers.B && scoring.tiers.B >= scoring.tiers.C;

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Weights</h2>
        <span className="text-sm tabular-nums text-slate-500">max score {max}</span>
      </div>
      {dimensions.map((key) => {
        const { label, weight } = scoring.dimensions[key];
        return (
          <label key={key} className="block text-sm">
            <span className="flex justify-between">
              <span>{label}</span>
              <span className="tabular-nums text-slate-600">{weight}</span>
            </span>
            <input type="range" min={0} max={50} step={1} value={weight} onChange={(e) => setWeight(key, Number(e.target.value))} className="w-full accent-slate-900" />
          </label>
        );
      })}

      <div>
        <h3 className="text-sm font-semibold">Tier minimums</h3>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {(['A', 'B', 'C'] as const).map((tier) => (
            <label key={tier} className="text-sm">
              {tier}
              <input
                type="number"
                min={0}
                max={100}
                value={scoring.tiers[tier]}
                onChange={(e) => setTier(tier, Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 tabular-nums"
              />
            </label>
          ))}
        </div>
        {!tiersInOrder && <p className="mt-1 text-xs text-rose-700">Keep A ≥ B ≥ C, or the exported file will be rejected.</p>}
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={exportJson} className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
          Export scoring.json
        </button>
        <button type="button" onClick={onReset} disabled={!edited} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40">
          Reset
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Edits are not saved. Replace config/scoring.json with the export to apply them to the webhook, or pass it to the CLI with --scoring. A dimension at weight 0
        also stops paying for its expansion.
      </p>
    </div>
  );
}
