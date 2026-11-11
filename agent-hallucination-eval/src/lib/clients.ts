import Anthropic from '@anthropic-ai/sdk';
import { CompanyEnrich } from '@companyenrich/sdk';
import { UsageError } from './errors.ts';

export function createCompanyEnrichClient(): CompanyEnrich {
  if (!process.env.COMPANYENRICH_API_KEY) {
    throw new UsageError(
      'COMPANYENRICH_API_KEY is not set. Create a key at https://companyenrich.com/dashboard and export it.',
    );
  }
  // The API is sometimes slow; 30 seconds per attempt leaves room without hanging a run.
  return new CompanyEnrich({ timeoutMs: 30_000 });
}

export function createAnthropicClient(adapter: string): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new UsageError(
      `${adapter} needs ANTHROPIC_API_KEY. The oracle and abstain baselines run without any key.`,
    );
  }
  return new Anthropic();
}
