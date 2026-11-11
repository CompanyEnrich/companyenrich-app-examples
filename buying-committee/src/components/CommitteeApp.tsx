'use client';

import { useMemo, useRef, useState } from 'react';
import { estimateCredits, PRICES } from '@/lib/credits';
import { committeeCsv, type EmailBook } from '@/lib/export';
import type { CommitteeMap, MappedPerson } from '@/lib/types';
import { AccountInput } from './AccountInput';
import { api, type CoverageResponse } from './api';
import { CostConfirm } from './CostConfirm';
import { CoverageTable } from './CoverageTable';
import { RoleMap } from './RoleMap';

interface PresetOption {
  id: string;
  name: string;
  summary: string;
}

export function CommitteeApp({ presets, llmEnabled }: { presets: PresetOption[]; llmEnabled: boolean }) {
  const [domains, setDomains] = useState<string[]>([]);
  const [mode, setMode] = useState<'preset' | 'describe'>('preset');
  const [preset, setPreset] = useState('devtools');
  const [description, setDescription] = useState('');
  const [workforce, setWorkforce] = useState(false);

  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [map, setMap] = useState<CommitteeMap | null>(null);
  const [emails, setEmails] = useState<EmailBook>({});
  const [busy, setBusy] = useState<'coverage' | 'map' | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [creditsUsed, setCreditsUsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Bumped whenever the plan's inputs change, so responses to older requests are ignored.
  const requestId = useRef(0);

  const estimate = useMemo(() => (coverage ? estimateCredits(coverage.plan, { workforce }) : null), [coverage, workforce]);
  const remaining = coverage ? coverage.credits.total - coverage.credits.used - creditsUsed : 0;

  /** Any change to accounts or product invalidates the plan, its estimate and its results. */
  function resetResults(): number {
    requestId.current++;
    setCoverage(null);
    setMap(null);
    setEmails({});
    setCreditsUsed(0);
    setBusy(null);
    setError(null);
    return requestId.current;
  }

  async function checkCoverage() {
    const id = resetResults();
    setBusy('coverage');
    try {
      const result = await api.coverage(mode === 'preset' ? { domains, preset } : { domains, description });
      if (id === requestId.current) setCoverage(result);
    } catch (caught) {
      if (id === requestId.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (id === requestId.current) setBusy(null);
    }
  }

  async function mapPeople() {
    if (!coverage || !estimate) return;
    const id = requestId.current;
    setBusy('map');
    setError(null);
    try {
      // The server refuses paid work unless `confirmed` is true; this click is the confirmation.
      const { map: result } = await api.map({ plan: coverage.plan, workforce, maxCredits: estimate.maxCredits, confirmed: true });
      if (id !== requestId.current) return;
      setMap(result);
      setCreditsUsed((used) => used + result.creditsSpent);
    } catch (caught) {
      if (id === requestId.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (id === requestId.current) setBusy(null);
    }
  }

  async function revealEmail(person: MappedPerson, domain: string) {
    const id = requestId.current;
    setRevealing(person.id);
    setError(null);
    try {
      const { reveal } = await api.reveal({ personId: person.id, domain, confirmed: true });
      if (id !== requestId.current) return;
      setEmails((current) => ({ ...current, [person.id]: reveal }));
      // A found email costs 10 credits unless this account already accessed it; assume the worst.
      if (reveal.status === 'found') setCreditsUsed((used) => used + PRICES.emailFound);
    } catch (caught) {
      if (id === requestId.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRevealing(null);
    }
  }

  function downloadCsv() {
    if (!map) return;
    const url = URL.createObjectURL(new Blob([committeeCsv(map, emails)], { type: 'text/csv' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: `committee-${map.generatedAt.slice(0, 10)}.csv` });
    link.click();
    URL.revokeObjectURL(url);
  }

  const canCheck = domains.length > 0 && (mode === 'preset' || description.trim().length > 0) && busy === null;

  return (
    <div className="space-y-8">
      <section className="space-y-4 rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
        <fieldset disabled={busy === 'map'} className="space-y-4">
          <AccountInput
            domains={domains}
            onChange={(next) => {
              setDomains(next);
              resetResults();
            }}
          />

          <fieldset>
            <legend className="mb-1 text-sm font-medium">What you sell</legend>
            <div className="mb-2 flex gap-4 text-sm">
              {(['preset', 'describe'] as const).map((value) => (
                <label key={value} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === value}
                    onChange={() => {
                      setMode(value);
                      resetResults();
                    }}
                  />
                  {value === 'preset' ? 'Pick a category' : 'Describe it'}
                </label>
              ))}
            </div>
            {mode === 'preset' ? (
              <select
                className="w-full rounded-md border border-stone-300 bg-white px-2 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
                value={preset}
                onChange={(event) => {
                  setPreset(event.target.value);
                  resetResults();
                }}
              >
                {presets.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}: {option.summary}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <textarea
                  className="w-full rounded-md border border-stone-300 bg-white px-2 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
                  rows={2}
                  maxLength={500}
                  placeholder="e.g. We sell a feature-flag and experimentation platform to engineering teams"
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    resetResults();
                  }}
                />
                <p className="text-xs text-stone-500">
                  {llmEnabled
                    ? 'Claude drafts a custom committee from this; every filter is checked against the API taxonomy.'
                    : 'ANTHROPIC_API_KEY is not set: your description is matched to the nearest preset by keywords.'}
                </p>
              </>
            )}
          </fieldset>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={workforce} onChange={(event) => setWorkforce(event.target.checked)} />
            <span>
              Workforce check <span className="text-stone-500">(1 credit per account, runs with the paid step)</span>
              <span className="block text-xs text-stone-500">
                For roles with no matches, checks whether the team exists at all. If not, points to the executive who likely covers it.
              </span>
            </span>
          </label>

          <button
            type="button"
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
            disabled={!canCheck}
            onClick={checkCoverage}
          >
            {busy === 'coverage' ? 'Counting...' : 'Check coverage (free)'}
          </button>
        </fieldset>
      </section>

      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {coverage && (
        <section>
          <h2 className="mb-1 text-lg font-semibold">1. Coverage (free)</h2>
          <ul className="mb-3 text-sm text-stone-600 dark:text-stone-400">
            {coverage.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <CoverageTable plan={coverage.plan} />
        </section>
      )}

      {coverage && estimate && coverage.plan.accounts.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">2. Cost estimate</h2>
          <CostConfirm estimate={estimate} remaining={remaining} busy={busy === 'map'} onConfirm={mapPeople} />
        </section>
      )}

      {map && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">3. Role map</h2>
            <div className="flex items-center gap-3 text-sm text-stone-600 dark:text-stone-400">
              <span>{map.creditsSpent} credits spent</span>
              <button type="button" className="rounded-md border border-stone-300 px-3 py-1.5 dark:border-stone-700" onClick={downloadCsv}>
                Export CSV
              </button>
            </div>
          </div>
          {map.stoppedEarly && (
            <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              Stopped early: {map.stoppedEarly} The people below were already paid for and are kept.
            </p>
          )}
          {map.accounts.map((account) => (
            <RoleMap key={account.account.domain} account={account} reveal={{ emails, pending: revealing, onReveal: revealEmail }} />
          ))}
          <p className="text-xs text-stone-500">
            A map of likely roles, inferred from title, department and seniority. Not an org chart, and not confirmed buying authority.
          </p>
        </section>
      )}
    </div>
  );
}
