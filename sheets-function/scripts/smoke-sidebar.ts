/**
 * Live smoke test of the sidebar's server functions, against the real API and
 * an in-memory spreadsheet. Spends about 16 credits: 2 lookalikes (10) and up
 * to 3 people (6). The column enrichment is free when `npm run smoke` has run
 * first, because it reuses the same saved document properties.
 *
 * People's names are masked in the output; titles and companies are shown.
 */
import { FakeSheet, FakeSpreadsheet } from '../harness/fakes.js';
import { STATE_FILE, creditsBilled, describeCalls, errorText, formatCredits, startLiveRun } from './live.js';

const spreadsheet = new FakeSpreadsheet([
  new FakeSheet('Accounts', [['Website'], ['stripe.com'], ['https://www.figma.com/pricing'], ['hubspot.com']]),
]);
const run = startLiveRun({ spreadsheet });
const { script, log } = run;

function section(title: string, task: () => void) {
  console.log(`\n${title}`);
  const before = log.length;
  try {
    task();
  } catch (error) {
    console.log(`  FAIL: ${errorText(error)}`);
    process.exitCode = 1;
  }
  const calls = log.slice(before);
  console.log(`  API calls: ${describeCalls(calls)}; credits billed: ${creditsBilled(calls)}`);
}

/** Prints a sheet as a table; `maskNames` hides names and LinkedIn URLs below the header. */
function printSheet(name: string, maskNames = false) {
  const rows = spreadsheet.getSheetByName(name)?.values() ?? [];
  rows.forEach((row, index) => {
    const cells = maskNames && index > 0 ? ['<name>', ...row.slice(1, -1), '<linkedin>'] : row;
    console.log(`  | ${cells.map((cell) => String(cell)).join(' | ')} |`);
  });
}

const start = log.length;
console.log('CompanyEnrich for Google Sheets: live sidebar smoke test');
console.log(`Document properties: ${STATE_FILE} (${run.savedCompanies()} companies saved)`);
const balanceBefore = run.balance();
console.log(`Balance before: ${formatCredits(balanceBefore)} credits`);

section('Sidebar state', () => {
  const state = script.getSidebarState();
  console.log(`  balance: ${formatCredits(state.balance)}; daily cap: ${state.budget.spent} of ${state.budget.cap} used today`);
});

section('Enrich selected column (Accounts!A1:A4, 4 fields)', () => {
  spreadsheet.select('Accounts', 'A1:A4');
  let job = script.estimateEnrichSelection(['name', 'industry', 'employees', 'location.country.name']);
  console.log(`  estimate: ${job.domains} domains, ${job.cached} cached, up to ${job.maxCredits} credits`);
  job = { ...job, confirmed: true }; // what the sidebar's confirm button sends
  while (!job.done) job = script.enrichSelectionChunk(job);
  console.log(`  done: ${job.billed} credits`);
  printSheet('Accounts');
});

section('Find lookalikes for stripe.com (2 results)', () => {
  spreadsheet.select('Accounts', 'A2');
  const plan = script.estimateLookalikes({ results: 2, country: '' });
  console.log(`  estimate: ${plan.available} available, ${plan.results} results, up to ${plan.maxCredits} credits`);
  const result = script.runLookalikes({ ...plan, confirmed: true });
  console.log(`  wrote ${result.rows} rows to "${result.sheetName}" for ${result.credits} credits`);
  printSheet(result.sheetName);
});

section('Find people at the 3 domains (c-suite, 1 per company)', () => {
  spreadsheet.select('Accounts', 'A1:A4');
  const plan = script.estimatePeople({ seniorities: ['c-suite'], perCompany: 1 });
  for (const company of plan.companies) console.log(`  ${company.domain}: ${company.available} match, taking ${company.take}`);
  console.log(`  estimate: ${plan.people} people, up to ${plan.maxCredits} credits`);
  const result = script.runPeople({ ...plan, confirmed: true });
  console.log(`  wrote ${result.rows} rows to "${result.sheetName}" for ${result.credits} credits${result.error ? `; error: ${result.error}` : ''}`);
  printSheet(result.sheetName, true);
});

run.save();
const calls = log.slice(start);
const balanceAfter = run.balance();
console.log('\nSummary');
console.log(`  Credits billed this run (from the responses): ${creditsBilled(calls)}`);
console.log(`  Balance after: ${formatCredits(balanceAfter)} (before minus after: ${formatCredits(balanceBefore - balanceAfter)}; the key may be shared)`);
