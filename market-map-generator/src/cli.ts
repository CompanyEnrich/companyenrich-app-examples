import { parseArgs } from 'node:util';
import { createClaudeNamer } from './lib/claude.ts';
import { createClient, describeApiError } from './lib/companyenrich.ts';
import { UsageError } from './lib/errors.ts';
import { run } from './lib/pipeline.ts';
import { loadTheme } from './lib/theme.ts';

const DEFAULT_MAX_CREDITS = 100;

const USAGE = `Usage: npm start -- <theme.yaml> [options]

Options:
  --companies <n>     Companies to fetch, 1-100 (default: the theme's "companies", or 20)
  --with-keywords     Also fetch each company's keywords for sharper clusters (+1 credit per company)
  --max-credits <n>   Stop before a search that could cost more than this (default ${DEFAULT_MAX_CREDITS})
  --dry-run           Free: count, API interpretation, preview and cost estimate only
  --out <dir>         Output folder (default output)
  --from <file>       Re-render from the companies.json of an earlier run (free, no API key needed)
  -h, --help          Show this help`;

async function main(): Promise<void> {
  const { values, positionals } = parseCommandLine();
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) throw new UsageError(`Pass exactly one theme file.\n\n${USAGE}`);
  if (values.from && values['dry-run']) throw new UsageError('--from re-renders saved data and spends nothing; drop --dry-run.');

  const theme = await loadTheme(positionals[0]!);
  const companies = values.companies === undefined ? theme.companies : parseInteger('--companies', values.companies, 1, 100);
  const maxCredits = values['max-credits'] === undefined ? DEFAULT_MAX_CREDITS : parseInteger('--max-credits', values['max-credits'], 0, 1_000_000);

  let client;
  if (!values.from) {
    if (!process.env.COMPANYENRICH_API_KEY) {
      throw new UsageError('COMPANYENRICH_API_KEY is not set. Create a key at https://companyenrich.com/dashboard and export it.');
    }
    client = createClient();
  }

  const result = await run(
    {
      theme,
      companies,
      withKeywords: values['with-keywords'] ?? false,
      maxCredits,
      dryRun: values['dry-run'] ?? false,
      outDir: values.out ?? 'output',
      ...(values.from ? { from: values.from } : {}),
    },
    { client, namer: createClaudeNamer(), log: (line) => console.log(line) },
  );

  if (result.kind === 'map') {
    console.log(`\nWrote:\n${result.files.map((file) => `  ${file}`).join('\n')}`);
    console.log(`Credits spent: ${result.creditsSpent}`);
  }
}

function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        companies: { type: 'string' },
        'with-keywords': { type: 'boolean' },
        'max-credits': { type: 'string' },
        'dry-run': { type: 'boolean' },
        out: { type: 'string' },
        from: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }
}

function parseInteger(flag: string, value: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new UsageError(`${flag} must be a whole number from ${min} to ${max}, got "${value}"`);
  return number;
}

main().catch((error: unknown) => {
  const message = error instanceof UsageError ? error.message : describeApiError(error);
  if (message === null) console.error(error);
  else console.error(`Error: ${message}`);
  process.exitCode = 1;
});
