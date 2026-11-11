'use client';

import { useId, useState, type ReactNode } from 'react';

export const buttonClass =
  'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
export const primaryButton = `${buttonClass} bg-accent text-accent-ink hover:opacity-90`;
export const secondaryButton = `${buttonClass} border border-line-strong bg-surface text-ink hover:bg-surface-2`;
export const inputClass =
  'w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted';

export function Panel({
  title,
  description,
  children,
  id,
  actions,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  id?: string;
  actions?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={headingId} className="text-base font-semibold">
            {title}
          </h2>
          {description && <p className="mt-1 text-sm text-ink-2">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A plain-words explanation under a control. */
export function Help({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} className="mt-1 text-xs text-muted">
      {children}
    </p>
  );
}

export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="border-t border-line pt-3 first:border-t-0 first:pt-0">
      <legend className="float-left mb-1 w-full text-sm font-medium">{label}</legend>
      <div className="clear-left">{children}</div>
      {help && <Help>{help}</Help>}
    </fieldset>
  );
}

/** Multi-select as a row of toggle buttons; each button reports `aria-pressed`. */
export function ToggleGroup<T extends string>({
  label,
  options,
  selected,
  onChange,
  max,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  selected: readonly T[];
  onChange: (next: T[]) => void;
  max?: number;
}) {
  const atMax = max !== undefined && selected.length >= max;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const pressed = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            disabled={!pressed && atMax}
            onClick={() =>
              onChange(pressed ? selected.filter((v) => v !== option.value) : [...selected, option.value])
            }
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 ${
              pressed
                ? 'border-accent bg-accent text-accent-ink'
                : 'border-line-strong bg-surface text-ink-2 hover:bg-surface-2'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function ChipList({
  items,
  onRemove,
  label,
}: {
  items: readonly { key: string; label: string }[];
  onRemove: (key: string) => void;
  label: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label={label} className="mt-2 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li
          key={item.key}
          className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-xs text-ink"
        >
          <span>{item.label}</span>
          <button
            type="button"
            onClick={() => onRemove(item.key)}
            aria-label={`Remove ${item.label}`}
            className="rounded-full px-1.5 text-ink-2 hover:bg-surface hover:text-ink"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Two number inputs for an inclusive range. Empty means "no bound". */
export function RangeInputs({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
}: {
  label: string;
  value: { min?: number; max?: number };
  onChange: (next: { min?: number; max?: number }) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  const update = (key: 'min' | 'max', raw: string) => {
    const next = { ...value };
    const parsed = raw === '' ? undefined : Number(raw);
    if (parsed === undefined || Number.isNaN(parsed)) delete next[key];
    else next[key] = parsed;
    onChange(next);
  };
  return (
    <div className="flex items-center gap-2">
      {(['min', 'max'] as const).map((key) => (
        <label key={key} className="flex flex-1 items-center gap-1.5 text-xs text-ink-2">
          <span className="w-8 shrink-0">{key === 'min' ? 'From' : 'To'}</span>
          <input
            type="number"
            inputMode="numeric"
            aria-label={`${label} ${key === 'min' ? 'from' : 'to'}${unit ? ` (${unit})` : ''}`}
            className={inputClass}
            value={value[key] ?? ''}
            min={min}
            max={max}
            step={step}
            onChange={(event) => update(key, event.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    setTimeout(() => setStatus('idle'), 2_000);
  };
  return (
    <button type="button" onClick={copy} className={secondaryButton}>
      <span aria-live="polite">{status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : label}</span>
    </button>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

export function ChipRow({ chips, tone = 'filter' }: { chips: { group: string; text: string }[]; tone?: 'filter' | 'boost' }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <li
          key={`${chip.group}:${chip.text}`}
          className={`rounded-md border px-2 py-1 text-xs ${
            tone === 'filter' ? 'border-accent/40 bg-accent-soft' : 'border-dashed border-line-strong bg-surface-2'
          }`}
        >
          <span className="text-ink-2">{chip.group}: </span>
          <span className="font-medium text-ink">{chip.text}</span>
        </li>
      ))}
    </ul>
  );
}

export const formatNumber = (n: number) => n.toLocaleString('en-US');
