'use client';

import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The visible stop before anything that spends credits. */
export function CostConfirm({ children, confirmLabel, busy, onConfirm, onCancel }: Props) {
  return (
    <div role="group" aria-label="Confirm credit spend" className="mt-3 rounded-lg border border-line bg-accent-wash p-3 text-sm sm:p-4">
      <div className="text-ink">{children}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-lg bg-accent-strong px-3 py-1.5 font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
