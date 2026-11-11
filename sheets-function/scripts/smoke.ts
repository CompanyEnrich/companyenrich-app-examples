/**
 * Live smoke test of the custom functions against the real CompanyEnrich API.
 *
 * The first run spends about 3 credits (one per domain). Later runs spend 0:
 * document properties, the persistent cache, are saved to a temp file between
 * runs, the way a spreadsheet keeps them. Pass --reset to start empty.
 */
import { createEnvironment } from '../harness/load.js';
import { createHttpUrlFetchApp } from '../harness/http-fetch.js';
import { STATE_FILE, creditsBilled, describeCalls, errorText, formatCredits, startLiveRun } from './live.js';

const DOMAINS = ['stripe.com', 'https://www.figma.com/pricing', 'hubspot.com'];
const UNKNOWN_DOMAIN = 'no-such-company-0x7f3a.com';

const run = startLiveRun();
const { script, log } = run;
let failures = 0;

function step(title: string, task: () => void, expectCalls?: number): void {
  console.log(`\n${title}`);
  const before = log.length;
  try {
    task();
  } catch (error) {
    failures++;
    console.log(`  FAIL: ${errorText(error)}`);
  }
  const calls = log.slice(before);
  console.log(`  API calls: ${describeCalls(calls)}; credits billed: ${creditsBilled(calls)}`);
  if (expectCalls !== undefined && calls.length !== expectCalls) {
    failures++;
    console.log(`  FAIL: expected ${expectCalls} API calls, got ${calls.length}`);
  }
}


function show(label: string, value: unknown) {
  console.log(`  ${label.padEnd(34)} ${JSON.stringify(value)}`);
}

function check(label: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok' : 'FAIL'}: ${label}`);
}

const start = log.length;
console.log('CompanyEnrich for Google Sheets: live smoke test');
console.log(`Document properties: ${STATE_FILE} (${run.savedCompanies()} companies saved before this run)`);
const balanceBefore = run.balance();
console.log(`Balance before: ${formatCredits(balanceBefore)} credits`);

try {
  step('1. =COMPANYENRICH(domain, "name") for 3 domains', () => {
    for (const domain of DOMAINS) show(domain, script.COMPANYENRICH(domain, 'name'));
  });

  step(
    '2. The same 3 formulas again, as a recalculation would',
    () => {
      for (const domain of DOMAINS) show(domain, script.COMPANYENRICH(domain, 'name'));
    },
    0,
  );

  step(
    '3. =COMPANYENRICH(A2:A4, "employees") with the domains as a range',
    () => show('A2:A4', script.COMPANYENRICH(DOMAINS.map((domain) => [domain]), 'employees')),
    0,
  );

  step(
    '4. =COMPANYENRICH_ROW("stripe.com", "name,industry,employees,country,foundedYear")',
    () => show('stripe.com', script.COMPANYENRICH_ROW('stripe.com', 'name,industry,employees,country,foundedYear')),
    0,
  );

  step('5. =COMPANYENRICH_COUNT("Germany", "51-200", "saas") (free)', () => {
    const count = script.COMPANYENRICH_COUNT('Germany', '51-200', 'saas');
    show('companies', count);
    check('returns a number', typeof count === 'number' && count > 0);
  });

  step('6. =COMPANYENRICH_COUNT("US", "", "") (free)', () => show('companies', script.COMPANYENRICH_COUNT('US', '', '')));

  step(`7. =COMPANYENRICH("${UNKNOWN_DOMAIN}", "name") (not found, free)`, () => {
    const value = script.COMPANYENRICH(UNKNOWN_DOMAIN, 'name');
    show(UNKNOWN_DOMAIN, value);
    check('shows "Not found"', value === 'Not found');
  });

  step('8. Error messages a cell would show', () => {
    const errorOf = (task: () => unknown) => {
      try {
        task();
        return '(no error)';
      } catch (error) {
        return errorText(error);
      }
    };
    const noKey = createEnvironment({ apiKey: null, urlFetch: createHttpUrlFetchApp(log) }).script;
    const badKey = createEnvironment({ apiKey: 'not-a-real-key', urlFetch: createHttpUrlFetchApp(log) }).script;
    const messages = {
      'missing key': errorOf(() => noKey.COMPANYENRICH_COUNT('US', '', '')),
      'invalid key': errorOf(() => badKey.COMPANYENRICH_COUNT('US', '', '')),
      'unknown field': errorOf(() => script.COMPANYENRICH('stripe.com', 'headcount')),
    };
    for (const [label, message] of Object.entries(messages)) show(label, message);
    check('missing key explains the menu', messages['missing key'].includes('Set API key'));
    check('invalid key reports 401', messages['invalid key'].includes('(401)'));
  });
} finally {
  run.save();
}

const calls = log.slice(start);
const spent = creditsBilled(calls);
const balanceAfter = run.balance();
console.log('\nSummary');
console.log(`  API calls this run: ${calls.length}`);
console.log(`  Credits billed this run (from the responses): ${spent}`);
console.log(`  Daily cap ledger for this "spreadsheet": ${script.getSidebarState().budget.spent} credits`);
console.log(`  Balance after: ${formatCredits(balanceAfter)} (before minus after: ${formatCredits(balanceBefore - balanceAfter)}; the key may be shared)`);
console.log(`  Companies saved in document properties: ${run.savedCompanies()}`);
if (failures) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed. Run it again: it should bill 0 credits.');
