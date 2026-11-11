// The behaviour of the company combobox, with no framework and no DOM:
// debounced suggestions, aborting stale suggestion requests, keyboard
// navigation and the enrich-on-select step with its cost reporting. The React component and the web component both render
// this one state machine, so they cannot drift apart.

import { CompanyLookupError, type CompanyClient } from './company-client';
import { MIN_QUERY_LENGTH, normalizeDomain, normalizeQuery } from '../shared/normalize';
import type { CompanyProfile, CompanySuggestion } from '../shared/types';

/** What `onSelect` receives after the user picks a company. */
export interface CompanySelection {
  domain: string;
  name: string;
  logoUrl: string | null;
  /** Enriched fields, or null when there is no data for the domain or the lookup failed. */
  company: CompanyProfile | null;
  /** Credits this pick spent: 1 for a fresh enrichment, 0 when cached or not found. */
  credits: number;
  cached: boolean;
  /** Why the lookup failed, safe to show. Null on success and when nothing was found. */
  error: string | null;
}

/**
 * What one enrichment cost, as reported by the server. Sent for every
 * enrichment that comes back, including one the user moved past before it
 * finished: the server completes (and bills) it either way.
 */
export interface EnrichmentCost {
  domain: string;
  credits: number;
  cached: boolean;
  /** True when the user had already typed or picked again, so the result was not used. */
  superseded: boolean;
}

/** A row in the listbox. `typed` marks the "Use <typed domain>" row. */
export interface CompanyOption extends CompanySuggestion {
  typed: boolean;
}

export type ComboboxStatus = 'idle' | 'loading' | 'ready' | 'error' | 'enriching' | 'selected';

export interface ComboboxState {
  inputValue: string;
  status: ComboboxStatus;
  options: CompanyOption[];
  open: boolean;
  /** Index of the option with visual focus (`aria-activedescendant`), or -1. */
  activeIndex: number;
  selection: CompanySelection | null;
  /** One line about the current state; empty when the options speak for themselves. */
  message: string;
}

export interface ComboboxControllerOptions {
  client: CompanyClient;
  minChars?: number;
  debounceMs?: number;
  onSelect?: (selection: CompanySelection) => void;
  /** Called when the user edits the text after picking, so the form can drop stale values. */
  onClear?: () => void;
  /** Called for every enrichment the server answers, so a ledger can count all spend. */
  onCost?: (cost: EnrichmentCost) => void;
}

const INITIAL_STATE: ComboboxState = {
  inputValue: '',
  status: 'idle',
  options: [],
  open: false,
  activeIndex: -1,
  selection: null,
  message: '',
};

export class CompanyComboboxController {
  #state: ComboboxState = INITIAL_STATE;
  readonly #listeners = new Set<() => void>();
  readonly #options: ComboboxControllerOptions;
  #debounceTimer: ReturnType<typeof setTimeout> | undefined;
  #suggestRequest: AbortController | undefined;
  // Enrichments are not aborted when the user moves on: the server would bill
  // them anyway, and letting them finish reports their cost and warms the cache.
  // A newer pick or edit bumps the generation so a late result is not applied.
  #enrichGeneration = 0;
  readonly #enrichRequests = new Set<AbortController>();

  constructor(options: ComboboxControllerOptions) {
    this.#options = options;
  }

  // Arrow functions so React's useSyncExternalStore can take them unbound.
  getState = (): ComboboxState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The user typed, pasted or cleared the text. */
  setInput(value: string): void {
    this.#cancelSuggestions();
    this.#enrichGeneration += 1;
    const hadSelection = this.#state.selection !== null;
    const query = normalizeQuery(value);

    if (query.length < (this.#options.minChars ?? MIN_QUERY_LENGTH)) {
      this.#update({ ...INITIAL_STATE, inputValue: value });
    } else {
      // Keep the previous suggestions on screen while the next ones load.
      const options = this.#state.options.filter((option) => !option.typed);
      this.#update({ inputValue: value, status: 'loading', options, open: true, activeIndex: -1, selection: null, message: 'Searching…' });
      this.#debounceTimer = setTimeout(() => void this.#loadSuggestions(value, query), this.#options.debounceMs ?? 250);
    }
    if (hadSelection) this.#options.onClear?.();
  }

  /** Handles a keydown on the input. Returns true when the caller should preventDefault. */
  handleKey(key: string): boolean {
    const { open, options, activeIndex } = this.#state;
    const last = options.length - 1;
    switch (key) {
      case 'ArrowDown':
        if (options.length === 0) return false;
        this.#update({ open: true, activeIndex: open ? (activeIndex + 1) % options.length : 0 });
        return true;
      case 'ArrowUp':
        if (options.length === 0) return false;
        this.#update({ open: true, activeIndex: open && activeIndex > 0 ? activeIndex - 1 : last });
        return true;
      case 'Home':
      case 'End':
        // Only while an option has visual focus; otherwise they move the caret as usual.
        if (!open || activeIndex < 0) return false;
        this.#update({ activeIndex: key === 'Home' ? 0 : last });
        return true;
      case 'Enter':
        // With no active option, Enter falls through and submits the form.
        if (!open || activeIndex < 0) return false;
        void this.choose(activeIndex);
        return true;
      case 'Escape':
        if (open) {
          this.#update({ open: false, activeIndex: -1 });
          return true;
        }
        if (this.#state.inputValue) {
          this.setInput('');
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  /** Pointer hover moves visual focus too, so mouse and keyboard agree. */
  highlight(index: number): void {
    if (index !== this.#state.activeIndex) this.#update({ activeIndex: index });
  }

  /** Closes the popup, for example when the input loses focus. */
  close(): void {
    this.#cancelSuggestions();
    const status = this.#state.status === 'loading' ? 'idle' : this.#state.status;
    this.#update({ open: false, activeIndex: -1, status, message: status === 'idle' ? '' : this.#state.message });
  }

  /** Picks an option and enriches it. */
  async choose(index: number): Promise<void> {
    const option = this.#state.options[index];
    if (!option) return;
    this.#cancelSuggestions();
    const generation = ++this.#enrichGeneration;
    const isCurrent = () => generation === this.#enrichGeneration;
    const request = new AbortController();
    this.#enrichRequests.add(request);

    this.#update({
      inputValue: option.typed ? option.domain : option.name,
      status: 'enriching',
      open: false,
      activeIndex: -1,
      selection: null,
      message: `Looking up ${option.domain}…`,
    });

    let selection: CompanySelection;
    let message = '';
    try {
      const { company, credits, cached } = await this.#options.client.enrich(option.domain, request.signal);
      this.#options.onCost?.({ domain: company.domain, credits, cached, superseded: !isCurrent() });
      selection = { domain: company.domain, name: company.name, logoUrl: company.logoUrl ?? option.logoUrl, company, credits, cached, error: null };
    } catch (error) {
      if (request.signal.aborted) return;
      const notFound = error instanceof CompanyLookupError && error.code === 'not_found';
      const reason = notFound ? null : errorMessage(error, 'Company lookup failed.');
      message = reason ?? `No details found for ${option.domain}. Fill in the fields yourself.`;
      selection = { domain: option.domain, name: option.name, logoUrl: option.logoUrl, company: null, credits: 0, cached: false, error: reason };
    } finally {
      this.#enrichRequests.delete(request);
    }
    if (!isCurrent()) return;

    this.#update({ inputValue: selection.company ? selection.name : this.#state.inputValue, status: 'selected', selection, message });
    this.#options.onSelect?.(selection);
  }

  /** Stops pending timers and requests. Call when the view unmounts. */
  destroy(): void {
    this.#cancelSuggestions();
    this.#enrichGeneration += 1;
    for (const request of this.#enrichRequests) request.abort();
  }

  async #loadSuggestions(text: string, query: string): Promise<void> {
    const request = new AbortController();
    this.#suggestRequest = request;
    try {
      const suggestions = await this.#options.client.suggest(query, request.signal);
      if (request.signal.aborted) return;
      const options = withTypedDomain(suggestions, text);
      this.#update({ status: 'ready', options, open: true, activeIndex: -1, message: noMatchMessage(suggestions, options, text) });
    } catch (error) {
      if (request.signal.aborted) return;
      const options = withTypedDomain([], text);
      this.#update({ status: 'error', options, open: true, activeIndex: -1, message: errorMessage(error, 'Could not load suggestions.') });
    }
  }

  #cancelSuggestions(): void {
    clearTimeout(this.#debounceTimer);
    this.#suggestRequest?.abort();
  }

  #update(patch: Partial<ComboboxState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

/** Adds "Use <typed domain>" when the text is a domain that no suggestion matches exactly. */
function withTypedDomain(suggestions: CompanySuggestion[], text: string): CompanyOption[] {
  const options = suggestions.map((suggestion) => ({ ...suggestion, typed: false }));
  const domain = normalizeDomain(text);
  if (domain && !suggestions.some((suggestion) => suggestion.domain === domain)) {
    options.push({ domain, name: domain, logoUrl: null, typed: true });
  }
  return options;
}

function noMatchMessage(suggestions: CompanySuggestion[], options: CompanyOption[], text: string): string {
  if (suggestions.length > 0) return '';
  const hint = options.length > 0 ? '' : ' Try the company website, like acme.com.';
  return `No companies match “${text.trim()}”.${hint}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof CompanyLookupError ? error.message : fallback;
}

/** Text for a polite live region, so screen reader users hear what changed. */
export function announcement(state: ComboboxState): string {
  const count = state.options.filter((option) => !option.typed).length;
  if (state.open && state.status === 'ready' && count > 0) {
    return `${count} ${count === 1 ? 'company' : 'companies'} found. Use the up and down arrows to choose.`;
  }
  if (state.status === 'selected' && state.selection?.company) return `${state.selection.name} selected.`;
  return state.message;
}

/** One or two letters to show when a company has no logo. */
export function initials(name: string): string {
  // For a bare domain such as `acme.io`, only the first label is meaningful.
  const text = /^\S+\.\S+$/.test(name) ? (name.split('.')[0] ?? name) : name;
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
  return letters.map((word) => word?.charAt(0) ?? '').join('').toUpperCase() || '?';
}
