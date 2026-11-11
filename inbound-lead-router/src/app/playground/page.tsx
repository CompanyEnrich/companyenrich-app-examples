import { Playground } from '@/components/Playground';
import { ConfigError } from '@/lib/config';
import { loadPipelineConfig } from '@/lib/config-files';
import { secretConfigured } from '@/server/context';

export const dynamic = 'force-dynamic';

export default function PlaygroundPage() {
  let config;
  try {
    config = loadPipelineConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return <pre className="whitespace-pre-wrap rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error.message}</pre>;
  }

  return (
    <div className="space-y-6">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold">Rules playground</h1>
        <p className="mt-2 text-slate-600">
          Paste up to 20 domains to see how the current config scores, tiers and routes them. Estimating is free; running uses one{' '}
          <code className="rounded bg-slate-100 px-1">companies.enrichBatch</code> call after you confirm the cost, and cached companies are free. Then move the
          weights to see tiers change, without spending anything.
        </p>
      </div>
      <Playground scoring={config.scoring} routing={config.routing} secretRequired={secretConfigured()} />
    </div>
  );
}
