import type { ReactNode } from 'react';
import type { DecisionTrace } from '@/lib/trace';
import { CompanyCard } from './CompanyCard';
import { RuleList } from './RuleList';
import { ScoreBreakdown } from './ScoreBreakdown';
import { TierBadge } from './TierBadge';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

/** The full decision trace returned by POST /api/inbound. */
export function TraceView({ trace }: { trace: DecisionTrace }) {
  const { decision, trace: steps } = trace;
  const enrichment = steps.enrichment;
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <TierBadge tier={decision.tier} />
          {decision.score !== null && (
            <span className="text-2xl font-semibold tabular-nums">
              {decision.score}
              <span className="text-base font-normal text-slate-500"> / {decision.maxScore}</span>
            </span>
          )}
          <span className="text-slate-700">
            → <span className="font-medium">{decision.teamLabel}</span>, owner <span className="font-medium">{decision.owner}</span>
          </span>
        </div>
        <p className="mt-2 text-sm text-slate-600">{decision.summary}</p>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <Stat
            label="Credits"
            value={`${trace.credits.spent} (enrich ${trace.credits.enrich}, people ${trace.credits.people})${trace.credits.uncertain ? `, up to ${trace.credits.uncertain} more uncertain` : ''}`}
          />
          <Stat label="Time" value={`${trace.timings.totalMs} ms`} />
          <Stat label="Enrichment" value={enrichment.status === 'skipped' ? 'skipped' : `${enrichment.status} from ${enrichment.source}`} />
          <Stat label="Assignment" value={steps.assignment.reason} />
          <Stat label="Trace" value={trace.id} />
        </dl>
        {enrichment.status === 'skipped' && <p className="mt-2 text-sm text-slate-600">{enrichment.reason}</p>}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {trace.company && (
          <Card title="Company">
            <CompanyCard company={trace.company} />
          </Card>
        )}
        {steps.score && (
          <Card title="Score breakdown">
            <ScoreBreakdown score={steps.score} />
            {steps.tier && <p className="mt-2 text-sm text-slate-600">Tier: {steps.tier.reason}</p>}
          </Card>
        )}
        <Card title="Routing">
          <RuleList route={steps.routing} />
        </Card>
        <Card title="People and alert">
          <PeopleSection trace={trace} />
          <p className="mt-3 border-t border-slate-200 pt-3 text-sm text-slate-600">
            Alert: {steps.alert.channel === 'slack'
              ? steps.alert.delivered
                ? `posted to Slack (${steps.alert.status})`
                : `Slack post failed: ${steps.alert.error}`
              : steps.alert.reason}
          </p>
        </Card>
      </div>

      <details className="rounded-lg border border-slate-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium">Raw JSON response</summary>
        <pre className="mt-3 max-h-[32rem] overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(trace, null, 2)}</pre>
      </details>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function PeopleSection({ trace }: { trace: DecisionTrace }) {
  const step = trace.trace.people;
  if (step.status === 'skipped' || step.status === 'error') return <p className="text-sm text-slate-600">People: {step.reason}</p>;
  if (step.status === 'none-found') return <p className="text-sm text-slate-600">Nobody at this company matches the persona (free count was 0, no credits spent).</p>;
  return (
    <div>
      <p className="mb-2 text-sm text-slate-600">
        {step.people.length} of {step.matching} matching people ({step.source === 'cache' ? 'from cache, free' : `${step.credits} credits`})
      </p>
      <ul className="space-y-2">
        {step.people.map((person, index) => (
          <li key={person.linkedinUrl ?? index} className="text-sm">
            {person.linkedinUrl ? (
              <a href={person.linkedinUrl} className="font-medium text-sky-700 hover:underline" target="_blank" rel="noreferrer">
                {person.name ?? 'Unnamed'}
              </a>
            ) : (
              <span className="font-medium">{person.name ?? 'Unnamed'}</span>
            )}
            <span className="text-slate-600"> · {person.position ?? person.seniority ?? 'Unknown role'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
