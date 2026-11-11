'use client';

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { normalizeDomain } from '@/lib/domains';
import { api, type CompanyOption } from './api';
import { CompanyLogo } from './CompanyLogo';

interface Props {
  label: string;
  placeholder: string;
  /** Domains already picked; hidden from the suggestions. */
  exclude: readonly string[];
  disabled?: boolean;
  onSelect: (company: CompanyOption) => void;
}

/** Domain input with free CompanyEnrich autocomplete. Enter also accepts any valid domain as typed. */
export function CompanySearch({ label, placeholder, exclude, disabled, onSelect }: Props) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<CompanyOption[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setOptions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const { items } = await api.autocomplete(text, controller.signal);
        setOptions(items);
        setActive(-1);
        setError(null);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Autocomplete failed.');
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const visible = options.filter((option) => !exclude.includes(option.domain));
  const typedDomain = normalizeDomain(query);

  function choose(company: CompanyOption) {
    onSelect(company);
    setQuery('');
    setOptions([]);
    setOpen(false);
    setError(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => Math.max(-1, Math.min(visible.length - 1, current + step)));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const highlighted = visible[active];
      if (highlighted) choose(highlighted);
      else if (typedDomain && !exclude.includes(typedDomain)) {
        choose(visible.find((option) => option.domain === typedDomain) ?? { domain: typedDomain, name: typedDomain, logoUrl: null });
      } else if (query.trim()) setError(typedDomain ? 'Already picked.' : 'Type a domain such as example.com, or pick a suggestion.');
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  const listId = `${id}-list`;
  const showList = open && visible.length > 0;

  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base outline-none placeholder:text-muted focus:border-accent disabled:opacity-50"
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-lg"
        >
          {visible.map((option, index) => (
            <li
              key={option.domain}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${index === active ? 'bg-accent-wash' : ''}`}
            >
              <CompanyLogo src={option.logoUrl} />
              <span className="truncate font-medium">{option.name}</span>
              <span className="truncate text-ink-2">{option.domain}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1 text-sm text-critical">{error}</p>}
    </div>
  );
}
