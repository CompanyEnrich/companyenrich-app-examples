# CompanyEnrich App Examples

Complete, runnable apps built on the [CompanyEnrich API](https://docs.companyenrich.com): company and people enrichment, filter, semantic and lookalike search, workforce data and work emails.

Each folder is a self-contained TypeScript project you can copy out and run on its own. Each one solves a real go-to-market or data problem end to end, and has a README with real output, a diagram of how it works, the endpoints it calls, and what every step costs in credits. Every example has a free mode, so you can see what it would do before it spends anything.

## Examples

### AI agents

| Example | What it does | Type | Default demo |
| --- | --- | --- | --- |
| [agent-account-brief](./agent-account-brief) | An agent researches one account and writes a one-page brief in which every claim cites the API field it came from, inside a hard credit budget. | CLI, optional Claude | 8 credits (37 at full depth) |
| [slack-gtm-agent](./slack-gtm-agent) | A Slack bot that answers GTM questions with CompanyEnrich data, shows its plan and credit estimate, and waits for an Approve click before it spends. Uses the CompanyEnrich MCP server. | Slack bot, optional Claude | up to 4 credits |
| [agent-hallucination-eval](./agent-hallucination-eval) | Measures how often an LLM invents company facts, and how much grounding it with CompanyEnrich data helps. | CLI, Claude | 36 credits |

### Prospecting and pipeline

| Example | What it does | Type | Default demo |
| --- | --- | --- | --- |
| [customers-to-pipeline](./customers-to-pipeline) | Turns a CSV of your customers into an ICP filter, a free market size, lookalike accounts that are not customers yet, and the people to contact at each. | CLI | 47 credits |
| [buying-committee](./buying-committee) | Maps the people likely to be involved in a purchase at each target account, grouped by role, and shows which roles it could not fill. | Next.js + CLI, optional Claude | 0 for coverage, 36 with people and one email |
| [competitor-displacement](./competitor-displacement) | Finds companies that run a competitor's technology and not yours, sizes that market for free, ranks accounts by why-now signals and finds the buyer. | CLI | up to 30 credits |
| [champion-tracker](./champion-tracker) | A monthly job that tells account owners when a champion from a won deal changes company or gets promoted. | CLI + GitHub Action | 0 for the quickstart, about 2 per champion per check |

### Market and team analysis

| Example | What it does | Type | Default demo |
| --- | --- | --- | --- |
| [market-explorer](./market-explorer) | Sizes a B2B market for free: describe it in plain English or build filters, then see exact counts, a segment heatmap and sample companies. | Next.js | 0 credits |
| [market-map-generator](./market-map-generator) | Turns a theme like "AI agents for finance teams" into an investor-style market map of logos grouped into labelled categories. | CLI, optional Claude | 40 credits |
| [territory-planner](./territory-planner) | Splits a country into sales territories with a balanced number of ICP companies, using only free counts. | CLI | 0 credits |
| [peer-benchmark](./peer-benchmark) | Compares a company's team shape and 12-month growth with its peers, department by department. | Next.js | 5 credits |
| [talent-map](./talent-map) | Sizes a talent pool for free, shows which companies hold it and how their teams are trending, and builds a shortlist of profiles. | CLI | 0 for the dry run, 22 paid |

### RevOps and data operations

| Example | What it does | Type | Default demo |
| --- | --- | --- | --- |
| [inbound-lead-router](./inbound-lead-router) | Turns every signup into an enriched, scored and routed lead, with a Slack alert to the right owner. | Next.js webhook + CLI | up to 9 credits per new lead |
| [crm-enrichment-diff](./crm-enrichment-diff) | Shows exactly what enrichment would change in your CRM, applies your rules, and gives you a review page before anything is written. | CLI, optional HubSpot | 14 credits |
| [gtm-signal-monitor](./gtm-signal-monitor) | A scheduled job that watches for new matching companies, new leaders at your accounts and changes to account data, and posts a digest. | CLI + GitHub Action | 36 credits on the first run |

### Building blocks

| Example | What it does | Type | Default demo |
| --- | --- | --- | --- |
| [company-autocomplete](./company-autocomplete) | A drop-in company picker for forms: free suggestions with logos as you type, then one enrichment call fills in the rest. React, web component, Express and Cloudflare Worker. | Next.js + components | free to type, 1 credit per pick |
| [sheets-function](./sheets-function) | Company data in Google Sheets with `=COMPANYENRICH()`, plus a sidebar for bulk enrichment, lookalikes and people, without paying twice for the same company. | Google Apps Script | 3 credits |

"Default demo" is what the README's own demo costs on an empty cache. Re-runs are usually cheaper because the examples cache what they bought.

## Getting started

You need Node.js 22.12 or newer and an API key from your [CompanyEnrich dashboard](https://companyenrich.com/dashboard).

```sh
git clone https://github.com/companyenrich/companyenrich-app-examples.git
cd companyenrich-app-examples/market-explorer
npm install
```

Then follow that example's Quickstart. Each one reads the key from `COMPANYENRICH_API_KEY`, either from your shell or from the `.env` / `.env.local` file described in its README. Start with the `--dry-run` command or the free mode the README shows first.

## How credits work

Most of what makes these examples useful is free. The free endpoints answer "how many", "who matches" and "what is this called":

| Free | Paid |
| --- | --- |
| `companies.count`, `people.count` (any filter, semantic or lookalike query) | Company enrichment: 1 credit, +1 per paid expansion (`financial`, `keywords`, `naicsCodes`, `technologies`, `workforce`) |
| Company, technology, keyword and position autocomplete | Company search: 1 per result by filter, 2 by description, 5 for lookalikes |
| `geo.*`, `industries.list()`, `me()` | People search: 2 per person. Person by email: 5. Person by id: 2 |
| `companies.preview` (on plans with previews) | Workforce history: 1 per 12-month page. New work email: 10 |

An empty paid search still costs one result's base price, so every example runs the free count first and skips the paid call when it is zero. See the [API docs](https://docs.companyenrich.com) for the full price list.

Every example protects your balance in the same ways:

- It validates all input before the first paid call, including filter field names, so a typo fails before anything is spent.
- It shows an estimate before spending. CLIs have `--max-credits` and `--dry-run`; web apps enforce the confirm step and their caps on the server.
- It caches what it bought and never pays twice for the same company in one run.
- If a run fails partway, it keeps what it already paid for and reports what it actually spent.

## What was tested live

Every example was built and run live against the CompanyEnrich API, then checked independently by a second reviewer: a clean install, its tests, the README's commands, the live demo's spend against the account balance, failure cases and the spend caps.

Third-party services could not be tested live:

- **Claude** (`agent-account-brief`, `slack-gtm-agent`, `agent-hallucination-eval`, `buying-committee`, `market-map-generator`): tested against a mocked client. Every app runs without `ANTHROPIC_API_KEY`; the LLM steps switch off with a one-line notice. In `agent-hallucination-eval`, building the dataset and the baseline runs need no Anthropic key, and only the Claude runs do.
- **Slack** (`slack-gtm-agent`, `inbound-lead-router`, `gtm-signal-monitor`, `champion-tracker`): tested with signed requests and a local listener, not a real workspace.
- **HubSpot** (`crm-enrichment-diff`): the write-back is tested against a mocked API.
- **Google Sheets** (`sheets-function`): the Apps Script code runs in a Node harness against the real API, but has not been run inside a spreadsheet.

Each README says exactly what was tested live and what was mocked.

## Layout

Every example follows the same structure, so once you have read one you can find your way around the others:

```
example-name/
  README.md        what it does, real output, how it works, endpoints, credits, limitations
  src/lib/         the logic, as plain TypeScript modules with no framework imports
  src/cli.ts       or src/app/ for Next.js: a thin layer over src/lib
  test/            Vitest tests that run offline with a fake fetch, no key needed
  .env.example     every environment variable it reads
```

Every example passes `npm ci && npm run typecheck && npm test` offline, and `npm run build` where it has one.

## Contributing

New examples are welcome. [CONTRIBUTING.md](./CONTRIBUTING.md) has the checklist every example meets.

## License

[MIT](./LICENSE)
