import type { EmailReveal } from '@/lib/email';
import type { EmailBook } from '@/lib/export';
import type { AccountMap, MappedPerson } from '@/lib/types';

interface RevealState {
  emails: EmailBook;
  pending: string | null;
  onReveal: (person: MappedPerson, domain: string) => void;
}

/** Step 3: one card per role, with people or a clearly marked gap. */
export function RoleMap({ account, reveal }: { account: AccountMap; reveal: RevealState }) {
  const { account: company, adaptation, roles, gaps, singleThreaded } = account;
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-lg font-semibold">{company.name}</h3>
        <span className="text-sm text-stone-500">
          {company.domain} · {company.employees ?? 'size unknown'} employees
        </span>
        {singleThreaded && (
          <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-800 dark:text-amber-100">
            Single-threaded: depends on one contact
          </span>
        )}
      </header>
      <p className="mb-4 text-sm text-stone-600 dark:text-stone-400">{adaptation.join(' ')}</p>

      <div className="grid gap-3 md:grid-cols-2">
        {roles.map(({ role, count, people, notes }) => {
          const gap = gaps.find((candidate) => candidate.roleKey === role.key);
          return (
            <article
              key={role.key}
              className={`rounded-md border p-3 ${gap ? 'border-dashed border-red-300 bg-red-50/60 dark:border-red-800 dark:bg-red-950/30' : 'border-stone-200 dark:border-stone-700'}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h4 className="font-medium">{role.label}</h4>
                <span className="shrink-0 text-xs text-stone-500">{count} matching</span>
              </div>
              <p className="mb-2 text-xs text-stone-500">{role.why}</p>

              {people.map((person) => (
                <PersonRow key={person.id} person={person} domain={company.domain} reveal={reveal} />
              ))}

              {gap && (
                <div className="text-sm">
                  <p className="font-medium text-red-800 dark:text-red-300">Gap</p>
                  <p className="text-stone-700 dark:text-stone-300">{gap.reason}</p>
                  <p className="mt-1 text-stone-600 dark:text-stone-400">Next step: {gap.suggestion}</p>
                </div>
              )}
              {notes
                .filter((note) => !gap?.reason.includes(note))
                .map((note) => (
                  <p key={note} className="mt-1 text-xs text-stone-500">
                    {note}
                  </p>
                ))}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PersonRow({ person, domain, reveal }: { person: MappedPerson; domain: string; reveal: RevealState }) {
  const email: EmailReveal | undefined = reveal.emails[person.id];
  return (
    <div className="border-t border-stone-100 py-2 text-sm first-of-type:border-t-0 dark:border-stone-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{person.name}</span>
        {person.newInRole && (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100">
            New in role
          </span>
        )}
        {person.linkedinUrl && (
          <a className="text-xs text-sky-700 underline dark:text-sky-400" href={person.linkedinUrl} target="_blank" rel="noreferrer">
            LinkedIn
          </a>
        )}
      </div>
      <div className="text-stone-600 dark:text-stone-400">{person.title || 'No title'}</div>
      <div className="text-xs text-stone-500">
        {person.seniority ?? 'seniority unknown'} · {person.monthsInRole === null ? 'tenure unknown' : `${person.monthsInRole} months in role`}
      </div>
      <div className="mt-1">
        {email ? (
          email.email ? (
            <span className="text-sm">
              {email.email} <span className="text-xs text-stone-500">(certainty: {email.certainty ?? 'unknown'})</span>
            </span>
          ) : (
            <span className="text-xs text-stone-500">No email found ({email.status}).</span>
          )
        ) : (
          <button
            type="button"
            className="rounded border border-stone-300 px-2 py-0.5 text-xs hover:bg-stone-100 disabled:opacity-50 dark:border-stone-600 dark:hover:bg-stone-800"
            disabled={reveal.pending !== null}
            onClick={() => reveal.onReveal(person, domain)}
          >
            {reveal.pending === person.id ? 'Looking up...' : 'Reveal email (10 credits)'}
          </button>
        )}
      </div>
    </div>
  );
}
