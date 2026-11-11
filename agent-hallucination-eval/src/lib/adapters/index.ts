import { createAnthropicClient, createCompanyEnrichClient } from '../clients.ts';
import { abstain, oracle } from './baselines.ts';
import { claudeClosedBook, claudeWithCompanyEnrich, DEFAULT_MODEL, type Effort } from './claude.ts';
import { CompanyLookup } from './company-lookup.ts';
import type { Adapter, AdapterName } from './types.ts';

export interface AdapterSettings {
  effort: Effort;
  /** Spending cap for the `enrich_company` tool. */
  maxCredits: number;
}

export interface AdapterSetup {
  adapter: Adapter;
  /** The tool's lookup, for the credit report. Only the grounded adapter has one. */
  lookup: CompanyLookup | null;
}

/** Builds an adapter from the environment. Only the adapters that need a key ask for one. */
export async function createAdapter(name: AdapterName, settings: AdapterSettings): Promise<AdapterSetup> {
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  switch (name) {
    case 'oracle':
      return { adapter: oracle, lookup: null };
    case 'abstain':
      return { adapter: abstain, lookup: null };
    case 'claude-closed-book':
      return {
        adapter: claudeClosedBook({ client: createAnthropicClient(name), model, effort: settings.effort }),
        lookup: null,
      };
    case 'claude-with-companyenrich': {
      const anthropic = createAnthropicClient(name);
      const companyEnrich = createCompanyEnrichClient();
      await companyEnrich.me(); // Free: fails fast on a bad key before any model call.
      const lookup = new CompanyLookup(companyEnrich, { maxCredits: settings.maxCredits });
      return {
        adapter: claudeWithCompanyEnrich({ client: anthropic, model, effort: settings.effort, lookup }),
        lookup,
      };
    }
  }
}
