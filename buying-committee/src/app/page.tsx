import { CommitteeApp } from '@/components/CommitteeApp';
import { PRESETS } from '@/lib/blueprints';

// Reads ANTHROPIC_API_KEY at request time, so the notice reflects the running server.
export const dynamic = 'force-dynamic';

export default function Page() {
  const presets = PRESETS.map(({ id, name, summary }) => ({ id, name, summary }));
  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Buying committee mapper</h1>
        <p className="mt-1 max-w-2xl text-sm text-stone-600 dark:text-stone-400">
          Add target accounts and what you sell. See, for free, which committee roles have anyone in the data, then map the people
          for the roles that do. Built on the{' '}
          <a className="underline" href="https://docs.companyenrich.com">
            CompanyEnrich API
          </a>
          .
        </p>
      </header>
      <CommitteeApp presets={presets} llmEnabled={Boolean(process.env.ANTHROPIC_API_KEY)} />
    </main>
  );
}
