'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import {
  CompanyAutocomplete,
  CompanyLogo,
  type CompanySelection,
  type EnrichmentCost,
} from '../src/react/CompanyAutocomplete';
import type { EmployeeRange } from '../src/shared/types';

type FieldName = 'industry' | 'employees' | 'country';
type Fields = Record<FieldName, string>;

const FIELD_LABELS: Record<FieldName, string> = { industry: 'Industry', employees: 'Company size', country: 'Country' };
const NO_FIELDS: Fields = { industry: '', employees: '', country: '' };
const NOT_AUTO_FILLED: Record<FieldName, boolean> = { industry: false, employees: false, country: false };

const EMPLOYEE_RANGES: { value: EmployeeRange; label: string }[] = [
  { value: '1-10', label: '1–10 employees' },
  { value: '11-50', label: '11–50 employees' },
  { value: '51-200', label: '51–200 employees' },
  { value: '201-500', label: '201–500 employees' },
  { value: '501-1K', label: '501–1,000 employees' },
  { value: '1K-5K', label: '1,001–5,000 employees' },
  { value: '5K-10K', label: '5,001–10,000 employees' },
  { value: 'over-10K', label: '10,000+ employees' },
];

export function SignupForm() {
  const [selection, setSelection] = useState<CompanySelection | null>(null);
  const [fields, setFields] = useState<Fields>(NO_FIELDS);
  const [autoFilled, setAutoFilled] = useState(NOT_AUTO_FILLED);
  // Fed by onCost rather than onSelect, so a lookup the user moved past still counts.
  const [costs, setCosts] = useState<EnrichmentCost[]>([]);
  const [submitted, setSubmitted] = useState<Record<string, FormDataEntryValue> | null>(null);

  function handleSelect(next: CompanySelection) {
    setSelection(next);
    if (!next.company) return;

    const found: Fields = {
      industry: next.company.industry ?? '',
      employees: next.company.employees ?? '',
      country: next.company.country?.name ?? '',
    };
    // Fill fields that are empty or were filled by an earlier pick; never overwrite what the user typed.
    const writable = (name: FieldName) => found[name] !== '' && (fields[name] === '' || autoFilled[name]);
    const names = (Object.keys(found) as FieldName[]).filter(writable);
    setFields((previous) => ({ ...previous, ...Object.fromEntries(names.map((name) => [name, found[name]])) }));
    setAutoFilled((previous) => ({ ...previous, ...Object.fromEntries(names.map((name) => [name, true])) }));
  }

  function handleClear() {
    setSelection(null);
    setFields((previous) => ({
      industry: autoFilled.industry ? '' : previous.industry,
      employees: autoFilled.employees ? '' : previous.employees,
      country: autoFilled.country ? '' : previous.country,
    }));
    setAutoFilled(NOT_AUTO_FILLED);
  }

  function editField(name: FieldName, value: string) {
    setFields((previous) => ({ ...previous, [name]: value }));
    setAutoFilled((previous) => ({ ...previous, [name]: false }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(Object.fromEntries(new FormData(event.currentTarget)));
  }

  const totalCredits = costs.reduce((sum, cost) => sum + cost.credits, 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form onSubmit={handleSubmit} className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-lg font-semibold">Create your account</h2>

        <div>
          <FieldLabel htmlFor="email">Work email</FieldLabel>
          <input id="email" name="email" type="email" required autoComplete="email" placeholder="you@company.com" className={inputClass(false)} />
        </div>

        <CompanyAutocomplete
          name="companyDomain"
          label="Company"
          onSelect={handleSelect}
          onClear={handleClear}
          onCost={(cost) => setCosts((previous) => [...previous, cost])}
        />

        {selection && <SelectedCompany selection={selection} />}

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <FieldLabel htmlFor="industry" auto={autoFilled.industry}>
              Industry
            </FieldLabel>
            <input
              id="industry"
              name="industry"
              value={fields.industry}
              onChange={(event) => editField('industry', event.target.value)}
              className={inputClass(autoFilled.industry)}
            />
          </div>
          <div>
            <FieldLabel htmlFor="employees" auto={autoFilled.employees}>
              Company size
            </FieldLabel>
            <select
              id="employees"
              name="employees"
              value={fields.employees}
              onChange={(event) => editField('employees', event.target.value)}
              className={inputClass(autoFilled.employees)}
            >
              <option value="">Select…</option>
              {EMPLOYEE_RANGES.map((range) => (
                <option key={range.value} value={range.value}>
                  {range.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel htmlFor="country" auto={autoFilled.country}>
              Country
            </FieldLabel>
            <input
              id="country"
              name="country"
              value={fields.country}
              onChange={(event) => editField('country', event.target.value)}
              className={inputClass(autoFilled.country)}
            />
          </div>
        </div>

        <button
          type="submit"
          className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus:outline-none focus-visible:ring-3 focus-visible:ring-indigo-500/40"
        >
          Create account
        </button>
      </form>

      <aside className="space-y-4">
        <Panel title="Filled automatically">
          <ul className="space-y-2 text-sm">
            {(Object.keys(FIELD_LABELS) as FieldName[]).map((name) => (
              <li key={name} className="flex items-baseline justify-between gap-3">
                <span className="text-slate-500">{FIELD_LABELS[name]}</span>
                <span className={autoFilled[name] ? 'text-right font-medium text-indigo-700' : 'text-right text-slate-400'}>
                  {autoFilled[name] ? displayValue(name, fields[name]) : fields[name] ? 'typed by you' : 'not filled'}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="What this cost">
          <p className="text-sm">
            <span className="text-2xl font-semibold">{totalCredits}</span>{' '}
            <span className="text-slate-500">{totalCredits === 1 ? 'credit' : 'credits'} this session</span>
          </p>
          {costs.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {costs.map((cost, index) => (
                <li key={index} className="flex justify-between gap-3">
                  <span className="truncate text-slate-700">{cost.domain}</span>
                  <span className="shrink-0 text-slate-500">
                    {cost.credits} · {costLabel(cost)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            Suggestions while you type are free. Picking a company enriches it for 1 credit; the server caches the result
            for 24 hours, so picking it again costs nothing. Lookups that find nothing are free.
          </p>
        </Panel>

        {submitted && (
          <Panel title="Submitted values">
            <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">
              {JSON.stringify(submitted, null, 2)}
            </pre>
            <p className="mt-2 text-xs text-slate-500">Nothing is sent anywhere; this is what your backend would receive.</p>
          </Panel>
        )}
      </aside>
    </div>
  );
}

function SelectedCompany({ selection }: { selection: CompanySelection }) {
  const { company } = selection;
  const place = company ? [company.city, company.country?.name].filter(Boolean).join(', ') : '';
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <CompanyLogo name={selection.name} logoUrl={selection.logoUrl} className="size-10 rounded-md bg-white object-contain" fallbackClassName="flex size-10 items-center justify-center rounded-md bg-white text-sm font-semibold text-slate-600" />
      <div className="min-w-0 text-sm">
        <p className="truncate font-medium">{selection.name}</p>
        <p className="truncate text-slate-500">
          {selection.domain}
          {place ? ` · ${place}` : null}
          {company?.foundedYear ? ` · founded ${company.foundedYear}` : null}
        </p>
      </div>
    </div>
  );
}

function FieldLabel({ htmlFor, auto = false, children }: { htmlFor: string; auto?: boolean; children: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between">
      <label htmlFor={htmlFor} className="text-sm font-medium text-slate-800">
        {children}
      </label>
      {auto && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">Auto-filled</span>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function inputClass(autoFilled: boolean): string {
  const tone = autoFilled ? 'border-indigo-300 bg-indigo-50/40' : 'border-slate-300 bg-white';
  return `block w-full rounded-lg border ${tone} px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-3 focus:ring-indigo-500/20`;
}

function displayValue(name: FieldName, value: string): string {
  if (name !== 'employees') return value;
  return EMPLOYEE_RANGES.find((range) => range.value === value)?.label ?? value;
}

function costLabel(cost: EnrichmentCost): string {
  if (cost.cached) return 'cached';
  return cost.superseded ? 'enriched, then replaced' : 'enriched';
}
