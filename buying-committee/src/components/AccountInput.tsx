'use client';

import { useEffect, useState } from 'react';
import { MAX_ACCOUNTS, normalizeDomain } from '@/lib/domains';
import { api } from './api';

interface Suggestion {
  name: string;
  domain: string;
}

/** Domain chips with free company autocomplete. Accepts pasted comma or newline lists. */
export function AccountInput({ domains, onChange }: { domains: string[]; onChange: (domains: string[]) => void }) {
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [invalid, setInvalid] = useState<string[]>([]);

  useEffect(() => {
    const query = text.trim();
    if (query.length < 2 || /[\s,;]/.test(query)) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .autocomplete(query)
        .then(({ items }) => !cancelled && setSuggestions(items.slice(0, 6)))
        .catch(() => !cancelled && setSuggestions([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text]);

  function add(values: string[]) {
    const bad: string[] = [];
    const next = [...domains];
    for (const value of values.map((v) => v.trim()).filter(Boolean)) {
      const domain = normalizeDomain(value);
      if (!domain) bad.push(value);
      else if (!next.includes(domain) && next.length < MAX_ACCOUNTS) next.push(domain);
    }
    setInvalid(bad);
    onChange(next);
    setText('');
    setSuggestions([]);
  }

  return (
    <div>
      <label htmlFor="account-input" className="mb-1 block text-sm font-medium">
        Target accounts <span className="font-normal text-stone-500">({domains.length}/{MAX_ACCOUNTS})</span>
      </label>
      <div className="flex flex-wrap gap-2 rounded-md border border-stone-300 bg-white p-2 dark:border-stone-700 dark:bg-stone-900">
        {domains.map((domain) => (
          <span key={domain} className="inline-flex items-center gap-1 rounded bg-stone-100 px-2 py-1 text-sm dark:bg-stone-800">
            {domain}
            <button
              type="button"
              aria-label={`Remove ${domain}`}
              className="text-stone-500 hover:text-stone-900 dark:hover:text-white"
              onClick={() => onChange(domains.filter((d) => d !== domain))}
            >
              ×
            </button>
          </span>
        ))}
        <div className="relative min-w-48 flex-1">
          <input
            id="account-input"
            className="w-full bg-transparent px-1 py-1 text-sm outline-none"
            placeholder={domains.length ? 'Add another domain' : 'stripe.com, posthog.com, ...'}
            value={text}
            disabled={domains.length >= MAX_ACCOUNTS}
            onChange={(event) => {
              const value = event.target.value;
              if (/[,;\n]/.test(value)) add(value.split(/[,;\n]+/));
              else setText(value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (text.trim()) add([text]);
              } else if (event.key === 'Backspace' && !text && domains.length) {
                onChange(domains.slice(0, -1));
              }
            }}
            onBlur={() => setTimeout(() => setSuggestions([]), 150)}
          />
          {suggestions.length > 0 && (
            <ul className="absolute left-0 top-full z-10 mt-1 w-72 overflow-hidden rounded-md border border-stone-200 bg-white text-sm shadow-lg dark:border-stone-700 dark:bg-stone-900">
              {suggestions.map((suggestion) => (
                <li key={suggestion.domain}>
                  <button
                    type="button"
                    className="flex w-full justify-between gap-3 px-3 py-2 text-left hover:bg-stone-100 dark:hover:bg-stone-800"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => add([suggestion.domain])}
                  >
                    <span className="truncate font-medium">{suggestion.name}</span>
                    <span className="text-stone-500">{suggestion.domain}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {invalid.length > 0 && <p className="mt-1 text-sm text-red-700 dark:text-red-400">Not a domain: {invalid.join(', ')}</p>}
    </div>
  );
}
