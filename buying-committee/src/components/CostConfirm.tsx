import type { CreditEstimate } from '@/lib/credits';

interface Props {
  estimate: CreditEstimate;
  remaining: number;
  busy: boolean;
  onConfirm: () => void;
}

/** Step 2: the exact worst case, line by line, before anything is spent. */
export function CostConfirm({ estimate, remaining, busy, onConfirm }: Props) {
  const people = estimate.searches.reduce((total, line) => total + line.people, 0);
  const tooExpensive = estimate.maxCredits > remaining;

  if (estimate.maxCredits === 0) {
    return <p className="text-sm text-stone-600 dark:text-stone-400">Nothing to map: no role has matching people, so there is nothing worth paying for.</p>;
  }

  return (
    <div className="rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-stone-500">People searches</dt>
        <dd>
          {people} people across {estimate.searches.length} roles x 2 credits = <strong>{estimate.searchCredits}</strong>
        </dd>
        {estimate.workforceCredits > 0 && (
          <>
            <dt className="text-stone-500">Workforce check</dt>
            <dd>
              1 credit per account = <strong>{estimate.workforceCredits}</strong>
            </dd>
          </>
        )}
        {estimate.relabelReserve > 0 && (
          <>
            <dt className="text-stone-500">Relabeled roles</dt>
            <dd>
              up to <strong>{estimate.relabelReserve}</strong> if the workforce check finds a missing team
            </dd>
          </>
        )}
        <dt className="text-stone-500">Roles with 0 matches</dt>
        <dd>skipped, 0 credits</dd>
        <dt className="font-medium">Maximum</dt>
        <dd className="font-medium">
          {estimate.maxCredits} credits <span className="font-normal text-stone-500">({Math.floor(remaining)} available)</span>
        </dd>
      </dl>
      <button
        type="button"
        className="mt-4 rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
        disabled={busy || tooExpensive}
        onClick={onConfirm}
      >
        {busy ? 'Mapping people...' : `Map people (up to ${estimate.maxCredits} credits)`}
      </button>
      {tooExpensive && <p className="mt-2 text-sm text-red-700 dark:text-red-400">Not enough credits left for this run.</p>}
    </div>
  );
}
