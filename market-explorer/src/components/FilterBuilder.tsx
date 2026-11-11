'use client';

import { useState } from 'react';
import type { FilterState, TermLists } from '@/lib/filter';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  COMPANY_TYPES,
  EMPLOYEE_LABELS,
  EMPLOYEE_RANGES,
  FUNDING_ROUND_LABELS,
  FUNDING_ROUNDS,
  GROWTH_DEPARTMENT_LABELS,
  GROWTH_DEPARTMENTS,
  GROWTH_PERIOD_LABELS,
  GROWTH_PERIODS,
  REVENUE_LABELS,
  REVENUE_RANGES,
  TYPE_LABELS,
  type GrowthDepartment,
  type GrowthPeriod,
} from '@/lib/options';
import type { IndustriesResponse, RegionsResponse } from '@/lib/responses';
import type { AutocompleteKind } from '@/lib/schemas';
import { getJson, useRemote } from './api';
import { Autocomplete } from './Autocomplete';
import { ChipList, Field, Help, Panel, RangeInputs, ToggleGroup, inputClass, secondaryButton } from './ui';

const options = <T extends string>(values: readonly T[], labels: Record<T, string>) =>
  values.map((value) => ({ value, label: labels[value] }));

const without = <T,>(list: readonly T[], predicate: (item: T) => boolean) => list.filter((item) => !predicate(item));

export function FilterBuilder({
  state,
  onChange,
  onClear,
}: {
  state: FilterState;
  onChange: (update: (previous: FilterState) => FilterState) => void;
  onClear: () => void;
}) {
  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    onChange((previous) => ({ ...previous, [key]: value }));
  const countryCodes = state.countries.map((c) => c.value);

  return (
    <Panel
      title="Filters"
      description="Every control maps to one field of the v2 company search filter. Fields combine with AND."
      actions={
        <button type="button" onClick={onClear} className={secondaryButton}>
          Clear all
        </button>
      }
    >
      <div className="space-y-4">
        <Field label="Country" help="Headquartered in any of these countries.">
          <Autocomplete
            kind="countries"
            label="Add a country"
            placeholder="Search countries, e.g. Germany"
            onPick={(s) =>
              !countryCodes.includes(String(s.value)) &&
              set('countries', [...state.countries, { value: String(s.value), label: s.label }])
            }
          />
          <ChipList
            label="Selected countries"
            items={state.countries.map((c) => ({ key: c.value, label: c.label }))}
            onRemove={(key) => set('countries', without(state.countries, (c) => c.value === key))}
          />
        </Field>

        <Field label="Region" help="A group of countries, such as Western Europe. Matches any selected region.">
          <RegionSelect
            selected={state.regions.map((r) => r.value)}
            onAdd={(region) => set('regions', [...state.regions, region])}
          />
          <ChipList
            label="Selected regions"
            items={state.regions.map((r) => ({ key: r.value, label: r.label }))}
            onRemove={(key) => set('regions', without(state.regions, (r) => r.value === key))}
          />
        </Field>

        <Field
          label="State or city"
          help="Narrows to states or cities (matches any). Suggestions are limited to the countries above when you pick some."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <Autocomplete
              kind="states"
              label="Add a state or province"
              placeholder="State, e.g. California"
              countries={countryCodes}
              onPick={(s) =>
                !state.states.some((x) => x.value === s.value) &&
                set('states', [...state.states, { value: Number(s.value), label: s.label }])
              }
            />
            <Autocomplete
              kind="cities"
              label="Add a city"
              placeholder="City, e.g. Berlin"
              countries={countryCodes}
              onPick={(s) =>
                !state.cities.some((x) => x.value === s.value) &&
                set('cities', [...state.cities, { value: Number(s.value), label: s.label }])
              }
            />
          </div>
          <ChipList
            label="Selected states and cities"
            items={[
              ...state.states.map((s) => ({ key: `state:${s.value}`, label: s.label })),
              ...state.cities.map((c) => ({ key: `city:${c.value}`, label: c.label })),
            ]}
            onRemove={(key) => {
              const [kind, id] = key.split(':');
              if (kind === 'state') set('states', without(state.states, (s) => String(s.value) === id));
              else set('cities', without(state.cities, (c) => String(c.value) === id));
            }}
          />
        </Field>

        <Field
          label="Industry"
          help="v2 has no industry field, so each industry adds its NAICS code prefixes from the free industries list. Matches any."
        >
          <IndustrySelect
            selected={state.industries.map((i) => i.name)}
            onAdd={(industry) => set('industries', [...state.industries, industry])}
          />
          <ChipList
            label="Selected industries"
            items={state.industries.map((i) => ({ key: i.name, label: i.name.replace('/', ' / ') }))}
            onRemove={(key) => set('industries', without(state.industries, (i) => i.name === key))}
          />
        </Field>

        <Field label="Employees" help="Estimated headcount range. Matches any selected range.">
          <ToggleGroup
            label="Employees"
            options={options(EMPLOYEE_RANGES, EMPLOYEE_LABELS)}
            selected={state.employees}
            onChange={(v) => set('employees', v)}
          />
        </Field>

        <Field label="Revenue" help="Estimated annual revenue in USD. Matches any selected range.">
          <ToggleGroup
            label="Revenue"
            options={options(REVENUE_RANGES, REVENUE_LABELS)}
            selected={state.revenue}
            onChange={(v) => set('revenue', v)}
          />
        </Field>

        <Field
          label="Category"
          help={
            state.categoryMatch === 'all'
              ? 'Business model tags. "Match all" keeps companies tagged with every selected category.'
              : 'Business model tags. "Match any" keeps companies tagged with at least one selected category.'
          }
        >
          <ToggleGroup
            label="Category"
            options={options(CATEGORIES, CATEGORY_LABELS)}
            selected={state.categories}
            onChange={(v) => set('categories', v)}
          />
          <div role="radiogroup" aria-label="Category matching" className="mt-2 flex gap-4 text-xs text-ink-2">
            {(['all', 'any'] as const).map((match) => (
              <label key={match} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="category-match"
                  checked={state.categoryMatch === match}
                  onChange={() => set('categoryMatch', match)}
                />
                Match {match}
              </label>
            ))}
          </div>
        </Field>

        <Field label="Company type" help="Legal or ownership type. Matches any selected type.">
          <ToggleGroup
            label="Company type"
            options={options(COMPANY_TYPES, TYPE_LABELS)}
            selected={state.types}
            onChange={(v) => set('types', v)}
          />
        </Field>

        <Field label="Technologies" help="Detected website and product technologies, e.g. stripe, hubspot, react.">
          <TermEditor
            kind="technologies"
            noun="technology"
            lists={state.technologies}
            onChange={(v) => set('technologies', v)}
            modeLabels={{ all: 'Uses all of', any: 'Uses any of', exclude: 'Does not use' }}
          />
        </Field>

        <Field label="Keywords" help="Topics companies describe themselves with, e.g. fintech, payroll, devops.">
          <TermEditor
            kind="keywords"
            noun="keyword"
            lists={state.keywords}
            onChange={(v) => set('keywords', v)}
            modeLabels={{ all: 'Has all of', any: 'Has any of', exclude: 'Has none of' }}
          />
        </Field>

        <Field label="Founded" help="Year the company was founded, inclusive. Leave a side empty for no limit.">
          <RangeInputs
            label="Founded year"
            value={state.foundedYear}
            onChange={(v) => set('foundedYear', v)}
            min={1800}
            max={2100}
          />
        </Field>

        <Field label="Funding round" help="Companies that have raised any of these round types.">
          <ToggleGroup
            label="Funding round"
            options={options(FUNDING_ROUNDS, FUNDING_ROUND_LABELS)}
            selected={state.fundingRounds}
            onChange={(v) => set('fundingRounds', v)}
          />
        </Field>

        <Field label="Last funding year" help="Year of the most recent funding round, inclusive.">
          <RangeInputs
            label="Last funding year"
            value={state.fundingYear}
            onChange={(v) => set('fundingYear', v)}
            min={1900}
            max={2100}
          />
        </Field>

        <Field label="Funding amount (USD millions)" help="Disclosed funding amount. 10 means $10M.">
          <RangeInputs
            label="Funding amount"
            unit="USD millions"
            value={{
              min: state.fundingAmount.min === undefined ? undefined : state.fundingAmount.min / 1e6,
              max: state.fundingAmount.max === undefined ? undefined : state.fundingAmount.max / 1e6,
            }}
            onChange={({ min, max }) =>
              set('fundingAmount', {
                ...(min !== undefined && { min: Math.max(0, min) * 1e6 }),
                ...(max !== undefined && { max: Math.max(0, max) * 1e6 }),
              })
            }
            min={0}
            step={0.5}
          />
        </Field>

        <Field
          label="Headcount growth"
          help="Companies whose observed headcount grew by at least this much over the period, overall or in one department."
        >
          <GrowthControl value={state.workforceGrowth} onChange={(v) => set('workforceGrowth', v)} />
        </Field>
      </div>
    </Panel>
  );
}

function TermEditor({
  kind,
  noun,
  lists,
  onChange,
  modeLabels,
}: {
  kind: AutocompleteKind;
  noun: string;
  lists: TermLists;
  onChange: (next: TermLists) => void;
  modeLabels: Record<keyof TermLists, string>;
}) {
  const [mode, setMode] = useState<keyof TermLists>('all');
  const modes = ['all', 'any', 'exclude'] as const;
  const add = (term: string) => {
    const clean = term.trim();
    if (!clean) return;
    const next: TermLists = {
      all: without(lists.all, (t) => t === clean),
      any: without(lists.any, (t) => t === clean),
      exclude: without(lists.exclude, (t) => t === clean),
    };
    next[mode] = [...next[mode], clean];
    onChange(next);
  };
  return (
    <div>
      <div role="radiogroup" aria-label={`Add ${noun} to`} className="mb-2 flex flex-wrap gap-1">
        {modes.map((m) => (
          <label
            key={m}
            className={`cursor-pointer rounded-md border px-2 py-1 text-xs has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
              mode === m ? 'border-accent bg-accent-soft text-ink' : 'border-line-strong text-ink-2'
            }`}
          >
            <input
              type="radio"
              className="sr-only"
              name={`${kind}-mode`}
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            {modeLabels[m]}
          </label>
        ))}
      </div>
      <Autocomplete
        kind={kind}
        label={`${modeLabels[mode]}: add a ${noun}`}
        placeholder={`Type a ${noun}, Enter to add`}
        allowFreeText
        onPick={(s) => add(String(s.value))}
      />
      {modes.map((m) =>
        lists[m].length > 0 ? (
          <div key={m} className="mt-2">
            <p className="text-xs font-medium text-ink-2">{modeLabels[m]}</p>
            <ChipList
              label={modeLabels[m]}
              items={lists[m].map((t) => ({ key: t, label: t }))}
              onRemove={(key) => onChange({ ...lists, [m]: without(lists[m], (t) => t === key) })}
            />
          </div>
        ) : null,
      )}
      {lists.all.length + lists.any.length + lists.exclude.length > 0 && (
        <Help>
          Sent as{' '}
          <code className="font-mono">
            {'{'}
            {[lists.all.length && 'all', lists.any.length && 'in', lists.exclude.length && 'notIn']
              .filter(Boolean)
              .join(', ')}
            {'}'}
          </code>
          .
        </Help>
      )}
    </div>
  );
}

function RegionSelect({ selected, onAdd }: { selected: string[]; onAdd: (region: { value: string; label: string }) => void }) {
  const regions = useRemote('regions', (signal) => getJson<RegionsResponse>('/api/regions', signal));
  const items = regions.data?.items ?? [];
  const parents = items.filter((r) => r.parent === null);
  return (
    <select
      aria-label="Add a region"
      className={inputClass}
      value=""
      disabled={items.length === 0}
      onChange={(event) => {
        const region = items.find((r) => r.value === event.target.value);
        if (region) onAdd({ value: region.value, label: region.label });
      }}
    >
      <option value="">{regions.error ? 'Regions unavailable' : items.length ? 'Add a region…' : 'Loading regions…'}</option>
      {parents.map((parent) => (
        <optgroup key={parent.value} label={parent.label}>
          {[parent, ...items.filter((r) => r.parent === parent.value)].map((region) => (
            <option key={region.value} value={region.value} disabled={selected.includes(region.value)}>
              {region === parent ? `All of ${region.label}` : region.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function IndustrySelect({
  selected,
  onAdd,
}: {
  selected: string[];
  onAdd: (industry: { name: string; naicsCodes: string[] }) => void;
}) {
  const industries = useRemote('industries', (signal) => getJson<IndustriesResponse>('/api/industries', signal));
  const items = industries.data?.items ?? [];
  const groups = [...new Set(items.map((i) => i.name.split('/')[0] ?? i.name))];
  return (
    <select
      aria-label="Add an industry"
      className={inputClass}
      value=""
      disabled={items.length === 0}
      onChange={(event) => {
        const industry = items.find((i) => i.name === event.target.value);
        if (industry) onAdd(industry);
      }}
    >
      <option value="">
        {industries.error ? 'Industries unavailable' : items.length ? 'Add an industry…' : 'Loading industries…'}
      </option>
      {groups.map((group) => (
        <optgroup key={group} label={group}>
          {items
            .filter((i) => (i.name.split('/')[0] ?? i.name) === group)
            .map((i) => (
              <option key={i.name} value={i.name} disabled={selected.includes(i.name)}>
                {i.name.includes('/') ? i.name.split('/').slice(1).join(' / ') : `All of ${i.name}`}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

function GrowthControl({
  value,
  onChange,
}: {
  value: FilterState['workforceGrowth'];
  onChange: (next: FilterState['workforceGrowth']) => void;
}) {
  const current = value ?? { period: 'y1' as GrowthPeriod, department: 'overall' as GrowthDepartment, minPercent: 20 };
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value !== null} onChange={(e) => onChange(e.target.checked ? current : null)} />
        Only growing companies
      </label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs text-ink-2">
          Department
          <select
            className={`${inputClass} mt-1`}
            disabled={value === null}
            value={current.department}
            onChange={(e) => onChange({ ...current, department: e.target.value as GrowthDepartment })}
          >
            {GROWTH_DEPARTMENTS.map((d) => (
              <option key={d} value={d}>
                {GROWTH_DEPARTMENT_LABELS[d]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-2">
          Period
          <select
            className={`${inputClass} mt-1`}
            disabled={value === null}
            value={current.period}
            onChange={(e) => onChange({ ...current, period: e.target.value as GrowthPeriod })}
          >
            {GROWTH_PERIODS.map((p) => (
              <option key={p} value={p}>
                {GROWTH_PERIOD_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-2 sm:col-span-2">
          Min growth (%)
          <input
            type="number"
            className={`${inputClass} mt-1`}
            disabled={value === null}
            value={current.minPercent}
            min={-100}
            max={1000}
            step={5}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (e.target.value !== '' && !Number.isNaN(n)) onChange({ ...current, minPercent: n });
            }}
          />
        </label>
      </div>
    </div>
  );
}
