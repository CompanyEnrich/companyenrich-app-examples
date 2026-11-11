'use client';

import { Fragment, useMemo, useRef, useState } from 'react';
import type { RoutingConfig, ScoringConfig } from '@/lib/config';
import { evaluateCompany, type Evaluation } from '@/lib/evaluate';
import type { PlaygroundResponse, PlaygroundRow } from '@/lib/playground';
import { postJson } from './api';
import { RuleList } from './RuleList';
import { ScoreBreakdown } from './ScoreBreakdown';
import { TierBadge } from './TierBadge';
import { WeightsEditor } from './WeightsEditor';

const MAX_DOMAINS = 20;
const STATUS_LABEL: Record<string, string> = {
  'to-enrich': 'to enrich',
  'free-mail': 'free-mail, skipped',
  invalid: 'not a domain',
  'not-found': 'company not found',
  'invalid-domain': 'invalid domain',
  pending: 'still enriching, try later',
  error: 'error',
};

interface Props {
  scoring: ScoringConfig;
  routing: RoutingConfig;
  secretRequired: boolean;
}

export function Playground({ scoring: initialScoring, routing, secretRequired }: Props) {
  const [text, setText] = useState('vercel.com\nstripe.com\ndemo@gmail.com');
  const [secret, setSecret] = useState('');
  const [scoring, setScoring] = useState(initialScoring);
  // The response, plus the exact domain list it was made for, so Confirm runs the plan that was priced.
  const [result, setResult] = useState<{ domains: string[]; response: PlaygroundResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  // Bumped on every request and every edit; a response for an older id is ignored.
  const requestId = useRef(0);
  const response = result?.response ?? null;

  const domains = text.split(/[\n,]+/).map((line) => line.trim()).filter(Boolean);
  const tooMany = domains.length > MAX_DOMAINS;
  const edited = JSON.stringify(scoring) !== JSON.stringify(initialScoring);

  // Re-score in the browser whenever the weights change: no API calls, no credits.
  const evaluations = useMemo(() => {
    const now = new Date();
    return (response?.rows ?? []).map((row) =>
      row.company ? { edited: evaluateCompany(row.company, scoring, routing, now), original: evaluateCompany(row.company, initialScoring, routing, now) } : null,
    );
  }, [response, scoring, initialScoring, routing]);

  async function call(body: { domains: string[]; confirm?: boolean; maxCredits?: number }) {
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const next = await postJson<PlaygroundResponse>('/api/playground', body, secret);
      if (id !== requestId.current) return;
      setResult({ domains: body.domains, response: next });
      setOpen(null);
    } catch (caught) {
      if (id === requestId.current) setError((caught as Error).message);
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }

  function edit(value: string) {
    requestId.current++;
    setText(value);
    setResult(null);
    setError(null);
    setBusy(false);
  }

  const estimate = response?.mode === 'estimate' ? response : null;
  const count = (status: string) => response?.rows.filter((row) => row.status === status).length ?? 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <label className="block text-sm font-medium" htmlFor="domains">
            Domains or emails, one per line (up to {MAX_DOMAINS})
          </label>
          <textarea
            id="domains"
            rows={6}
            value={text}
            onChange={(e) => edit(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 p-2 font-mono text-sm"
          />
          {secretRequired && (
            <input
              type="password"
              placeholder="Webhook secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || domains.length === 0 || tooMany}
              onClick={() => call({ domains })}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-40"
            >
              Estimate cost (free)
            </button>
            {estimate && result && (
              <button
                type="button"
                disabled={busy}
                onClick={() => call({ domains: result.domains, confirm: true, maxCredits: estimate.credits })}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {estimate.credits > 0 ? `Run for up to ${estimate.credits} credits` : 'Score (free, all cached)'}
              </button>
            )}
            {busy && <span className="text-sm text-slate-500">Working…</span>}
            {tooMany && <span className="text-sm text-rose-700">Keep it to {MAX_DOMAINS} domains.</span>}
          </div>
          {estimate && (
            <p className="mt-3 text-sm text-slate-600">
              {count('to-enrich')} to enrich × {estimate.creditsPerCompany} credits (enrich{estimate.expand.map((name) => ` + ${name}`).join('')}), {count('found')}{' '}
              cached (free), {count('free-mail')} free-mail and {count('invalid')} invalid skipped. Companies that are not found cost nothing.{' '}
              {estimate.remainingToday} credits left under today&apos;s cap.
            </p>
          )}
          {response?.mode === 'result' && (
            <p className="mt-3 text-sm text-slate-600">
              Spent {response.credits} credits.
            </p>
          )}
          {error && <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">{error}</p>}
        </div>

        {response && (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Domain</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2 text-right">Score</th>
                  <th className="px-3 py-2">Tier</th>
                  <th className="px-3 py-2">Route</th>
                </tr>
              </thead>
              <tbody>
                {response.rows.map((row, index) => (
                  <Row key={`${row.input}-${index}`} row={row} evaluation={evaluations[index] ?? null} open={open === index} onToggle={() => setOpen(open === index ? null : index)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <WeightsEditor scoring={scoring} onChange={setScoring} onReset={() => setScoring(initialScoring)} edited={edited} />
    </div>
  );
}

interface RowProps {
  row: PlaygroundRow;
  evaluation: { edited: Evaluation; original: Evaluation } | null;
  open: boolean;
  onToggle: () => void;
}

function Row({ row, evaluation, open, onToggle }: RowProps) {
  const current = evaluation?.edited;
  const before = evaluation?.original.tier?.tier;
  const changed = current?.tier && before && current.tier.tier !== before;
  return (
    <Fragment>
      <tr className="border-b border-slate-100 align-top">
        <td className="px-3 py-2 font-mono text-xs">
          {current ? (
            <button type="button" onClick={onToggle} className="text-left text-sky-700 hover:underline" aria-expanded={open}>
              {open ? '▾' : '▸'} {row.domain}
            </button>
          ) : (
            (row.domain ?? row.input)
          )}
        </td>
        <td className="px-3 py-2">
          {row.company?.name ?? <span className="text-slate-500">{STATUS_LABEL[row.status] ?? row.status}</span>}
          {row.source === 'cache' && <span className="ml-2 text-xs text-slate-400">cached</span>}
          {row.message && <span className="block text-xs text-rose-700">{row.message}</span>}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{current?.score ? current.score.total : ''}</td>
        <td className="px-3 py-2">
          {current && <TierBadge tier={current.tier?.tier ?? null} />}
          {changed && <span className="ml-2 text-xs text-slate-500">was {before}</span>}
        </td>
        <td className="px-3 py-2 text-slate-700">{current ? current.route.teamLabel : ''}</td>
      </tr>
      {open && current?.score && (
        <tr className="border-b border-slate-100 bg-slate-50/60">
          <td colSpan={5} className="px-3 py-4">
            <div className="grid gap-6 md:grid-cols-2">
              <ScoreBreakdown score={current.score} />
              <RuleList route={current.route} />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
