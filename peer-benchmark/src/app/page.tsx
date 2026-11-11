import { BenchmarkApp } from '@/components/BenchmarkApp';
import { selectionFromQuery } from '@/lib/share-url';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // A shared link (?company=...&peers=...) pre-fills the picks. Nothing is spent until you confirm.
  const initial = selectionFromQuery(await searchParams);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Peer benchmark</h1>
        <p className="mt-2 max-w-2xl text-ink-2">
          Pick a company and its peers to compare team shape and 12-month growth, department by department. Built on
          CompanyEnrich workforce data: observed headcount from people profiles, classified by job title.
        </p>
      </header>
      <BenchmarkApp initial={initial} />
    </main>
  );
}
