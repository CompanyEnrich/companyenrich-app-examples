'use client';

// An accessible company picker following the WAI-ARIA combobox pattern
// (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/): an editable input with
// a listbox popup, `aria-activedescendant` for the highlighted option, and
// arrow keys, Home/End, Enter and Escape. The behaviour lives in
// CompanyComboboxController; this file only renders it.

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createCompanyClient } from '../client/company-client';
import {
  CompanyComboboxController,
  announcement,
  initials,
  type CompanySelection,
  type EnrichmentCost,
} from '../client/combobox-controller';

export type { CompanySelection, EnrichmentCost } from '../client/combobox-controller';
export type { CompanyProfile } from '../shared/types';

/** Every Tailwind class the component uses. Override any key with `classNames`. */
export const defaultClassNames = {
  root: 'relative',
  label: 'mb-1.5 block text-sm font-medium text-slate-800',
  field: 'relative',
  input:
    'block w-full rounded-lg border border-slate-300 bg-white py-2 pl-3 pr-10 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-3 focus:ring-indigo-500/20',
  spinner:
    'pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-600',
  popup: 'absolute inset-x-0 z-20 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg',
  listbox: 'max-h-80 overflow-y-auto py-1 empty:hidden',
  option: 'flex cursor-pointer items-center gap-3 px-3 py-2 text-sm',
  optionActive: 'bg-indigo-50',
  logo: 'size-8 shrink-0 rounded-md border border-slate-100 bg-white object-contain',
  initials: 'flex size-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold text-slate-600',
  optionText: 'min-w-0 flex-1',
  optionName: 'block truncate font-medium text-slate-900',
  optionDomain: 'block truncate text-xs text-slate-500',
  message: 'px-3 py-2 text-sm text-slate-500',
  hint: 'mt-1.5 text-sm text-slate-500',
  srOnly: 'sr-only',
};

export type CompanyAutocompleteClassNames = typeof defaultClassNames;

export interface CompanyAutocompleteProps {
  /** URL of the server handler. Read once, on mount. Default: `/api/company`. */
  endpoint?: string;
  label?: string;
  /** When set, a hidden input submits the picked domain under this name. */
  name?: string;
  placeholder?: string;
  /** Characters needed before suggestions load. Default: 2. */
  minChars?: number;
  /** Pause after the last keystroke before asking for suggestions. Default: 250 ms. */
  debounceMs?: number;
  /** Called after a pick, once the enrichment has finished (or failed). */
  onSelect?: (selection: CompanySelection) => void;
  /** Called when the user edits the text after a pick. */
  onClear?: () => void;
  /** Called for every enrichment the server answers, including ones the user moved past. */
  onCost?: (cost: EnrichmentCost) => void;
  classNames?: Partial<CompanyAutocompleteClassNames>;
}

export function CompanyAutocomplete({
  endpoint = '/api/company',
  label = 'Company',
  name,
  placeholder = 'Company name or website',
  minChars,
  debounceMs,
  onSelect,
  onClear,
  onCost,
  classNames,
}: CompanyAutocompleteProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const listboxId = `${id}-listbox`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const cx = { ...defaultClassNames, ...classNames };

  // The controller is created once; the latest callbacks are read through a ref.
  const callbacks = useRef({ onSelect, onClear, onCost });
  useEffect(() => {
    callbacks.current = { onSelect, onClear, onCost };
  });
  const [controller] = useState(
    () =>
      new CompanyComboboxController({
        client: createCompanyClient(endpoint),
        minChars,
        debounceMs,
        onSelect: (selection) => callbacks.current.onSelect?.(selection),
        onClear: () => callbacks.current.onClear?.(),
        onCost: (cost) => callbacks.current.onCost?.(cost),
      }),
  );
  useEffect(() => () => controller.destroy(), [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const { inputValue, status, options, open, activeIndex, selection, message } = state;

  // Keep the highlighted option visible while arrowing through the list.
  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, id]);

  return (
    <div className={cx.root}>
      <label htmlFor={inputId} className={cx.label}>
        {label}
      </label>
      <div className={cx.field}>
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={inputValue}
          onChange={(event) => controller.setInput(event.target.value)}
          onKeyDown={(event) => {
            if (controller.handleKey(event.key)) event.preventDefault();
          }}
          onBlur={() => controller.close()}
          className={cx.input}
        />
        {(status === 'loading' || status === 'enriching') && <span aria-hidden="true" className={cx.spinner} />}
      </div>

      <div className={cx.popup} hidden={!open}>
        <ul id={listboxId} role="listbox" aria-label={`${label} suggestions`} className={cx.listbox}>
          {options.map((option, index) => (
            <li
              key={`${option.typed ? 'typed' : 'company'}:${option.domain}`}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? `${cx.option} ${cx.optionActive}` : cx.option}
              // Keep focus in the input so the click does not blur and close the popup first.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => controller.highlight(index)}
              onClick={() => void controller.choose(index)}
            >
              <CompanyLogo
                name={option.name}
                logoUrl={option.logoUrl}
                className={cx.logo}
                fallbackClassName={cx.initials}
              />
              <span className={cx.optionText}>
                <span className={cx.optionName}>{option.typed ? `Use “${option.domain}”` : option.name}</span>
                {!option.typed && <span className={cx.optionDomain}>{option.domain}</span>}
              </span>
            </li>
          ))}
        </ul>
        {open && message && <p className={cx.message}>{message}</p>}
      </div>

      {!open && message && <p className={cx.hint}>{message}</p>}
      <p role="status" className={cx.srOnly}>
        {announcement(state)}
      </p>
      {name && <input type="hidden" name={name} value={selection?.domain ?? ''} />}
    </div>
  );
}

/** A company logo that falls back to initials when there is no logo or it fails to load. */
export function CompanyLogo({
  name,
  logoUrl,
  className = defaultClassNames.logo,
  fallbackClassName = defaultClassNames.initials,
}: {
  name: string;
  logoUrl: string | null;
  className?: string;
  fallbackClassName?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (logoUrl && logoUrl !== failedUrl) {
    return <img src={logoUrl} alt="" loading="lazy" className={className} onError={() => setFailedUrl(logoUrl)} />;
  }
  return (
    <span aria-hidden="true" className={fallbackClassName}>
      {initials(name)}
    </span>
  );
}
