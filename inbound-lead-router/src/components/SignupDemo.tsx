'use client';

import { useRef, useState, type FormEvent } from 'react';
import type { DecisionTrace } from '@/lib/trace';
import { postJson } from './api';
import { TraceView } from './TraceView';

const SOURCES = ['website-signup', 'demo-request', 'pricing-page', 'webinar'];
const inputStyle = 'mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';

/** A signup form that posts to the real webhook, exactly like your product would. */
export function SignupDemo({ secretRequired }: { secretRequired: boolean }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [source, setSource] = useState(SOURCES[0]!);
  const [secret, setSecret] = useState('');
  const [trace, setTrace] = useState<DecisionTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the latest submission may update the page.
  const requestId = useRef(0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    setTrace(null);
    try {
      const next = await postJson<DecisionTrace>('/api/inbound', { email, name: name || undefined, source }, secret);
      if (id === requestId.current) setTrace(next);
    } catch (caught) {
      if (id === requestId.current) setError((caught as Error).message);
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
      <form onSubmit={submit} className="h-fit space-y-4 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-semibold">Sign up</h2>
        <label className="block text-sm">
          Work email
          <input className={inputStyle} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="demo@company.com" />
        </label>
        <label className="block text-sm">
          Name <span className="text-slate-400">(optional)</span>
          <input className={inputStyle} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </label>
        <label className="block text-sm">
          Source
          <select className={inputStyle} value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        {secretRequired && (
          <label className="block text-sm">
            Webhook secret
            <input className={inputStyle} type="password" required value={secret} onChange={(e) => setSecret(e.target.value)} />
            <span className="mt-1 block text-xs text-slate-500">The server has INBOUND_WEBHOOK_SECRET set.</span>
          </label>
        )}
        <button type="submit" disabled={busy} className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">
          {busy ? 'Routing…' : 'Sign up'}
        </button>
        <p className="text-xs text-slate-500">
          Costs up to 3 credits for a new company, plus up to 6 for people at tier A accounts. Free-mail addresses and companies seen in the last 24 hours cost
          nothing.
        </p>
      </form>

      <div>
        {error && <p className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
        {trace ? (
          <TraceView trace={trace} />
        ) : (
          !error && (
            <div className="rounded-lg border border-dashed border-slate-300 p-8 text-sm text-slate-500">
              Submit a work email to see how the lead is enriched, scored, routed and alerted. Every step of the decision shows up here.
            </div>
          )
        )}
      </div>
    </div>
  );
}
