'use client';

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { AutocompleteResponse, Suggestion } from '@/lib/responses';
import type { AutocompleteKind } from '@/lib/schemas';
import { getJson, isAbort, useDebouncedValue } from './api';
import { inputClass } from './ui';

/**
 * A combobox backed by the free `/api/autocomplete/[kind]` route. With
 * `allowFreeText`, Enter also accepts whatever was typed.
 */
export function Autocomplete({
  kind,
  label,
  placeholder,
  onPick,
  countries = [],
  allowFreeText = false,
  disabled = false,
}: {
  kind: AutocompleteKind;
  label: string;
  placeholder?: string;
  onPick: (suggestion: Suggestion) => void;
  countries?: string[];
  allowFreeText?: boolean;
  disabled?: boolean;
}) {
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [items, setItems] = useState<Suggestion[]>([]);
  const query = useDebouncedValue(text.trim(), 250);
  const scope = countries.join(',');

  useEffect(() => {
    if (query === '') {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ q: query });
    if (scope) params.set('countries', scope);
    getJson<AutocompleteResponse>(`/api/autocomplete/${kind}?${params}`, controller.signal).then(
      (response) => {
        setItems(response.items);
        setActive(-1);
      },
      (error: unknown) => {
        if (!isAbort(error)) setItems([]);
      },
    );
    return () => controller.abort();
  }, [kind, query, scope]);

  const pick = (suggestion: Suggestion) => {
    onPick(suggestion);
    setText('');
    setItems([]);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(-1, i - 1));
    } else if (event.key === 'Enter') {
      const chosen = items[active];
      if (chosen) {
        event.preventDefault();
        pick(chosen);
      } else if (allowFreeText && text.trim() !== '') {
        event.preventDefault();
        pick({ value: text.trim(), label: text.trim() });
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const showList = open && items.length > 0;
  return (
    <div className="relative">
      <input
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        disabled={disabled}
        className={inputClass}
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={`${label} suggestions`}
        hidden={!showList}
        className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-line-strong bg-surface py-1 shadow-lg"
      >
        {items.map((item, index) => (
          <li
            key={`${item.value}`}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === active}
            onMouseDown={(event) => {
              event.preventDefault();
              pick(item);
            }}
            className={`cursor-pointer px-3 py-1.5 text-sm ${index === active ? 'bg-accent-soft' : 'hover:bg-surface-2'}`}
          >
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
