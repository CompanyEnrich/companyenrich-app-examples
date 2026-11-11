'use client';

import { useEffect, useState } from 'react';

/** A route handler answered with `{ error }`. The message is safe to show. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

async function handle<T>(response: Response): Promise<T> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed (${response.status}).`;
    throw new RequestError(message, response.status);
  }
  return data as T;
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return handle<T>(await fetch(url, { signal }));
}

export async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return handle<T>(
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** The value, updated only after it has stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface Remote<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Fetches whenever `key` changes and keeps the previous data while the next
 * request is in flight, so panels update in place instead of flashing.
 * `load` must be stable for a given key; pass `null` as key to skip.
 */
export function useRemote<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Remote<T> {
  const [state, setState] = useState<Remote<T>>({ data: null, error: null, loading: key !== null });
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true }));
    // Aborting cancels the request; the check also drops a response that resolved just before the abort.
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted && !isAbort(error)) {
          setState((previous) => ({ ...previous, error: errorMessage(error), loading: false }));
        }
      },
    );
    return () => controller.abort();
  }, [key]); // `load` is identified by `key`, so it is deliberately not a dependency.
  return state;
}
