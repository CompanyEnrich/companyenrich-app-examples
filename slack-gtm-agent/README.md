# Slack GTM Agent

A Slack bot that answers go-to-market questions with CompanyEnrich data, shows its plan and credit estimate, and waits for an Approve click before it spends.

Type `/ce people stripe.com vp sales` and the bot does a free count first: how many people match, and how the API read your words. Then it asks before it fetches anyone. Mention the bot with a question in plain English and Claude plans with CompanyEnrich tools. Each paid step is posted in the thread with its estimate, and steps above a threshold wait for a click. The bot is for GTM teams who want company and people data where they already work, and for agent builders who want a worked example of an LLM using the [official CompanyEnrich MCP server](https://github.com/CompanyEnrich/mcp-server) as its tool layer. Cost control sits in code between Claude and the tools: an estimate per call, approval above a threshold, and per-question, per-user and daily caps.

**What was tested live and what was mocked.** No Slack workspace and no Anthropic API key were available while building this. Everything on the CompanyEnrich side ran live against the real API: the MCP server over stdio, the free counts, `/ce company`, `/ce people` and `/ce lookalikes` after approval, and `/ce balance`. The Slack side was tested with correctly signed requests sent to the bot's local HTTP server. A local mock listener stood in for `response_url` and the Slack Web API. Agent mode (Claude) was tested only with a mocked Anthropic client. Treat the first run in a real workspace, and the first real Claude run, as untested.

## Example output

These are real replies from a live run of `npm run simulate`, which signs requests the way Slack does and prints the bot's replies as text. People's names, headlines and locations are replaced by placeholders.

`/ce count fintech startups in Berlin` (free):

```text
=== response_url, in_channel ===
*54,000* companies match _fintech startups in Berlin_.
The API read this as:
• city: 37140
  Free count. A semantic count is the size of the candidate pool the search ranks, so treat large numbers as an upper bound. City and state values are CompanyEnrich ids.
```

`/ce people stripe.com vp sales 2`, then Approve:

```text
=== response_url, ephemeral ===
*2* people at stripe.com match _vp sales_ (free count). Fetch 2?
• The API read the role words as seniority: vp
• The API read the role words as department: c-suite/sales-executive, sales
  Estimated cost: up to *4 credits*. Nothing is charged until you approve. This request expires in 15 minutes.
[Approve 4 credits] [Cancel]

>>> Clicking Approve as U0LOCALUSER

=== response_url, replaces the prompt ===
*2* people at stripe.com match _vp sales_ (free count). Fetch 2?
  :white_check_mark: Approved by <@U0LOCALUSER>. Fetching now.

=== response_url, in_channel ===
*People at stripe.com matching "vp sales"*
*<VP Business Development>*  <headline> · Stripe
vp · sales/business-development · <country>
*<VP Sales>*  <headline> · Stripe
vp · sales/sales · <country>
  4 credits spent · CompanyEnrich.
```

`/ce lookalikes stripe.com 2`, then Approve:

```text
=== response_url, in_channel ===
*Companies similar to stripe.com*
*PayPal* (paypal.com)
Finance · over-10K employees · London, United Kingdom · similarity 0.88
*GoCardless* (gocardless.com)
Finance · 501-1K employees · London, United Kingdom · similarity 0.88
  10 credits spent · CompanyEnrich.
```

`/ce company stripe.com` (1 credit) as Block Kit JSON, from `npm run simulate -- "/ce company stripe.com" --json` (description trimmed):

```json
[
  { "type": "header", "text": { "type": "plain_text", "text": "Stripe", "emoji": true } },
  {
    "type": "section",
    "text": { "type": "mrkdwn", "text": "Stripe provides financial infrastructure for businesses of all sizes. …" },
    "accessory": { "type": "image", "image_url": "https://api.companyenrich.com/companies/logo/0192577c-1d7a-715c-a5b7-1b9b530445e0", "alt_text": "Stripe logo" }
  },
  {
    "type": "section",
    "fields": [
      { "type": "mrkdwn", "text": "*Domain*\nstripe.com" },
      { "type": "mrkdwn", "text": "*Industry*\nFinance" },
      { "type": "mrkdwn", "text": "*Employees*\nover-10K" },
      { "type": "mrkdwn", "text": "*Revenue*\nover-1b" },
      { "type": "mrkdwn", "text": "*Founded*\n2010" },
      { "type": "mrkdwn", "text": "*HQ*\nSan Francisco, United States" },
      { "type": "mrkdwn", "text": "*Type*\nprivate" },
      { "type": "mrkdwn", "text": "*Funding*\nsecondary_market · $8.8B" }
    ]
  },
  { "type": "context", "elements": [{ "type": "mrkdwn", "text": "<https://www.linkedin.com/company/stripe|LinkedIn> · 1 credit · CompanyEnrich" }] }
]
```

`npm run tools` (free) lists the MCP server's tools live, next to the price this bot enforces:

```text
CompanyEnrich MCP server: 11 tools

enrich_company                 1 credit, plus 5 with includeWorkforce.
get_company_by_id              1 credit, plus 5 with includeWorkforce.
enrich_company_by_properties   1 credit, plus 5 with includeWorkforce.
get_company_workforce          5 credits.
search_companies               1 credit per company returned (2 with semanticQuery), plus 5 per company with includeWorkforce. Estimated as a full page of pageSize results.
find_similar_companies         5 credits per company returned, plus 5 per company with includeWorkforce. Estimated as a full page of pageSize results.
get_person_by_id               2 credits.
lookup_person_by_email         5 credits when a person is found.
enrich_person_email            10 credits per newly found email.
search_people                  2 credits per person returned. Estimated as a full page of pageSize results.
get_current_user               Free.

Added by this bot (CompanyEnrich SDK, v2 count endpoints):
count_companies                Free.
count_people                   Free.
```

In agent mode, a paid step that needs approval is posted in the thread like this. This example comes from the test suite, with a mocked Claude and fictional data:

```text
*Plan*
Fetching 12 of them.
• `search_people` seniority: vp; pageSize: 12  → up to *24 credits*
  Estimated up to *24 credits*, above the auto-approve threshold. Nothing is charged until you approve. Spent on this question so far: 0 credits.
[Approve 24 credits] [Cancel]
```

## How it works

1. **Startup.** The bot checks the API key with the free `me()` call. It then starts the official CompanyEnrich MCP server (`@companyenrich/mcp`) as a child process and connects over stdio with the MCP SDK client, then lists the server's tools.
2. **Toolbox.** Each MCP tool is matched to a cost rule in [`src/lib/costs.ts`](src/lib/costs.ts), a table keyed by tool name that estimates credits from the arguments. A tool without a rule stays hidden, so a new tool on the server cannot spend credits until someone prices it. Two free local tools are added, `count_companies` and `count_people`, built on `@companyenrich/sdk`. The MCP server leaves count helpers out on purpose, and a free count before every paid search is the core of the cost control.
3. **Every call goes through `Toolbox.call()`** ([`src/lib/toolbox.ts`](src/lib/toolbox.ts)). It estimates the cost and checks the per-question, per-user daily and total daily caps. It refuses a call above the approval threshold unless that amount was approved, and it reserves the estimate so parallel calls cannot overshoot. All tool calls share one limiter of 4 in flight. After the call it settles the reservation to the real charge, which the MCP server reports from the API's `x-credit-cost` header. A failure frees the reservation only when it cannot have been billed: input validation, a 4xx response such as not found, or an explicit cost of 0. A network error or 5xx after the request was sent counts at the estimate, because it may have been billed. A reservation is settled on the day it was made, so a call that straddles midnight cannot refund the next day's spend.
4. **Command mode** (`/ce ...`, no LLM). Slack posts the command to `/slack/events`. The bot rejects a timestamp more than 5 minutes from now in either direction (Bolt alone only rejects old ones), and Bolt checks the signature. The bot acknowledges within 3 seconds and runs the free count. For people and lookalikes it then posts an Approve button that carries only a random id. The arguments stay on the server, only the person who typed the command can click it, and the request expires after 15 minutes. After Approve it makes the paid call and posts the results.
5. **Agent mode** (`@companyenrich question`, needs `ANTHROPIC_API_KEY`). Claude (`claude-opus-5-5`) runs in the Anthropic SDK's tool runner. The tools come from the SDK's `mcpTools()` helper, given a budget-gated client instead of the raw MCP client. The runner hands over each assistant turn before running its tool calls, and the bot checks two rules in code:
   - **Count before paying.** A paid search runs only after a free count. For lookalike and semantic company searches, the bot runs the matching count itself. Other searches need a `count_people` or `count_companies` result from an earlier turn of the same question. No search runs when that count is 0.
   - **Plan and approval.** The bot sums the remaining paid calls of the turn into a plan and posts it with Claude's reason. If the plan is over the threshold, the bot waits for Approve.

   A refused, declined, expired or over-budget call goes back to Claude as an error result, so it answers with what it has.
6. **Answer.** Claude's text is posted as a Slack `markdown` block, with up to 10 result rows under it. When a table has more than 10 rows, the bot uploads it as a CSV with `files.uploadV2`.

```mermaid
flowchart TD
  S[Slack: /ce command, @mention or button click] -->|signed POST /slack/events| B[Bolt app, HTTP mode]
  B -->|/ce| C[Command handlers]
  B -->|@mention| A[Claude tool runner]
  C --> T[Toolbox: estimate, caps, approval, ledger]
  A -->|each turn's tool calls| P{Plan: paid credits?}
  P -->|0 credits| T
  P -->|within threshold| T
  P -->|over threshold| AP[Post plan with Approve button]
  AP -->|Approve| T
  AP -->|Cancel or expire| A
  T -->|count_companies, count_people| SDK[CompanyEnrich SDK, v2 count endpoints, free]
  T -->|paid tools, get_current_user| MCP[CompanyEnrich MCP server, child process over stdio]
  MCP --> API[(CompanyEnrich API)]
  SDK --> API
  T --> R[Rows: Block Kit, CSV upload over 10 rows]
  R --> S
```

### Why the MCP server, plus two SDK tools

The MCP server runs locally over stdio with nothing but `COMPANYENRICH_API_KEY`. It is a pinned npm dependency, so nothing is fetched at runtime. Using it means Claude sees the same tools as any MCP client, and the bot only adds pricing and gates. Two details shape the design:

- The free counts use the v2 count endpoints through the SDK. For `/ce people`, [`src/lib/filters.ts`](src/lib/filters.ts) translates the v2 interpretation (seniority, department, position, country, start dates) into the MCP tool's arguments. If the API reads the role words as a filter the MCP tool cannot express, the bot refuses with no spend rather than drop part of the question.
- The MCP server never retries a request, so a paid call cannot be billed twice by a retry. The SDK is used only for the free `me()` and count calls.

## CompanyEnrich endpoints used

| Tool (layer) | Endpoint | Why | Cost |
| --- | --- | --- | --- |
| `me()` (SDK) | `GET /v2/me` | Check the key at startup | Free |
| `count_companies` (SDK `companies.count`) | `POST /v2/companies/search/count` | `/ce count`, the free step of `/ce lookalikes`, agent sizing | Free |
| `count_people` (SDK `people.count`) | `POST /v2/people/search/count` | `/ce count people`, the free step of `/ce people`, agent sizing | Free |
| `get_current_user` (MCP) | `GET /me` | `/ce balance` | Free |
| `enrich_company` (MCP) | `GET /companies/enrich` | `/ce company` | 1 credit |
| `search_people` (MCP) | `POST /people/search` | `/ce people` after Approve, agent | 2 per person |
| `find_similar_companies` (MCP) | `POST /companies/similar` | `/ce lookalikes` after Approve, agent | 5 per company |
| `search_companies` (MCP) | `POST /companies/search` | Agent | 1 per company, 2 with `semanticQuery` |
| `get_company_by_id`, `enrich_company_by_properties` (MCP) | `GET /companies`, `POST /companies/enrich` | Agent | 1 credit |
| `get_company_workforce` (MCP) | `GET /companies/workforce` | Agent | 5 credits |
| `get_person_by_id` (MCP) | `GET /people` | Agent | 2 credits |
| `lookup_person_by_email` (MCP) | `POST /people/lookup` | Agent | 5 credits when found |
| `enrich_person_email` (MCP) | `GET /people/email` | Agent | 10 per newly found email |

MCP tools also take `includeWorkforce`, which adds 5 credits per company. API reference: https://docs.companyenrich.com.

## Quickstart

Node 22.12 or newer. Get an API key at https://companyenrich.com/dashboard. These commands run the bot against a local mock of Slack, so you don't need a workspace. The bot listens on port 3000; set `PORT` to change it.

```bash
cd slack-gtm-agent
npm install
export COMPANYENRICH_API_KEY=your-key
npm run simulate -- "/ce count fintech startups in Berlin"
npm run simulate -- "/ce people stripe.com vp sales 2" --approve
```

The first command is free. The second makes a free count, clicks Approve for you, and fetches 2 people for up to 4 credits. Without `--approve` it stops at the approval prompt, and `--cancel` clicks Cancel. Add `--json` to print the raw Block Kit. The simulator replaces people's names with their roles and hides LinkedIn profile URLs and emails; add `--show-pii` to see the real values.

To connect a real workspace:

1. Create the app at https://api.slack.com/apps: choose "Create New App", then "From a manifest", and paste [`manifest.yaml`](manifest.yaml). Replace `https://YOUR-HOST` with a public HTTPS URL that forwards to the bot's port, then install the app to the workspace.
2. Copy `.env.example` to `.env` and fill in `COMPANYENRICH_API_KEY`, `SLACK_SIGNING_SECRET` (Basic Information) and `SLACK_BOT_TOKEN` (OAuth & Permissions). Add `ANTHROPIC_API_KEY` to turn on agent mode.
3. Run `npm start`, then type `/ce help` in Slack. Invite the bot to a channel (`/invite @companyenrich`) before mentioning it there or asking for CSV files.

**Socket Mode instead of a public URL.** In Socket Mode, Bolt opens a WebSocket to Slack, so no public URL is needed. Set `socket_mode_enabled: true` in the manifest and delete the three `url`/`request_url` lines. Create an app-level token with the `connections:write` scope. In [`src/slack/app.ts`](src/slack/app.ts), pass `socketMode: true, appToken: process.env.SLACK_APP_TOKEN` to `new App(...)`. This variant was not built or tested here.

Other scripts: `npm run tools` lists the MCP server's tools with their prices (free), `npm test` runs the test suite (no network, no keys), and `npm run typecheck` runs the type check.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `COMPANYENRICH_API_KEY` | Yes | CompanyEnrich API key. Passed to the MCP server child process and the SDK. |
| `SLACK_SIGNING_SECRET` | Yes (not for `simulate`) | Verifies that requests come from Slack. |
| `SLACK_BOT_TOKEN` | Yes (not for `simulate`) | `xoxb-` token for posting messages and uploading CSV files. |
| `ANTHROPIC_API_KEY` | No | Turns on agent mode. Without it, mentions get a one-line notice and `/ce` works as usual. |
| `ANTHROPIC_MODEL` | No | Claude model, default `claude-opus-5-5`. |
| `PORT` | No | HTTP port for `/slack/events`, default `3000`. |
| `CE_APPROVAL_THRESHOLD` | No | Agent steps estimated above this many credits wait for Approve. Default `10`. |
| `CE_QUESTION_CAP` | No | Most credits one command or question may spend. Default `50`. |
| `CE_DAILY_USER_CAP` | No | Most credits one Slack user may spend per UTC day. Default `200`. |
| `CE_DAILY_TOTAL_CAP` | No | Most credits everyone together may spend per UTC day. Default `1000`. |
| `CE_LEDGER_FILE` | No | Where daily spend is saved, so a restart does not reset the caps. Default `state/ledger.json`. |
| `SLACK_API_URL` | No | Slack Web API base URL. Only for pointing the bot at a local mock. |

The bot reads `.env` from the working directory when it exists. Variables already set in the environment take precedence.

Slash command reference:

| Command | What it does | Cost |
| --- | --- | --- |
| `/ce company <domain>` | Company card | 1 credit |
| `/ce count <plain English>` | Company count and how the API read it | Free |
| `/ce count people <plain English>` | People count and how the API read it | Free |
| `/ce people <domain> <role words> [n]` | Free count, then up to `n` people (default 5, max 25) after Approve | 2 per person |
| `/ce lookalikes <domain> [n]` | Free count, then the `n` most similar companies (default 5, max 25) after Approve | 5 per company |
| `/ce balance` | Account credits, plus what you spent through the bot today | Free |
| `/ce help` | Usage, caps and the price of every tool | Free |

Results go to the channel. Approval prompts, help, balance and errors are visible only to the person who typed the command.

## Credits

| Step | Cost |
| --- | --- |
| Free counts, `/ce balance`, `/ce help`, startup key check | 0 |
| `/ce company` | 1 credit (0 if the domain is unknown) |
| `/ce people` after Approve | 2 per person returned, at most 2 × n |
| `/ce lookalikes` after Approve | 5 per company returned, at most 5 × n |
| Agent question | The sum of its plans; each plan is shown with its estimate before it runs |

**Quickstart total:** up to 4 credits (one free count, then 2 people). The whole build of this example, including probes and repeated demo runs, used 34 credits.

**How spend is capped:**

- Paid fetches in command mode always wait for Approve. Agent plans wait when their estimate is above `CE_APPROVAL_THRESHOLD`.
- `CE_QUESTION_CAP`, `CE_DAILY_USER_CAP` and `CE_DAILY_TOTAL_CAP` are enforced in `Toolbox.call()`, below Claude and below the Slack handlers. Neither a prompt nor a forged click can get around them.
- A call that fails after it may have been billed (network error, 5xx) counts at its estimate, so a flaky connection cannot slip past a cap. Only failures that cannot have been billed are refunded.
- A search is estimated as a full page. The ledger records what the API actually charged, which is less when fewer results come back.
- Small page sizes: commands fetch 5 by default, and Claude is told to use 5 to 10.

## Limitations

- **Slack and Claude were only tested with mocks.** Request signing, slash commands, buttons, `response_url`, `chat.postMessage`, `chat.update` and `files.uploadV2` were exercised against a local mock. The `markdown` block that carries Claude's answer, and any rendering details, were not checked in a real Slack client.
- **Counts are not market sizes.** A semantic company count is the size of the candidate pool that search ranks. Add filters such as country or size for a tighter number. Lookalike counts are similar pools.
- **Estimates are upper bounds** priced from the MCP server's documentation and a few live checks. The workforce surcharge (5 per company) comes from the MCP docs and was not measured.
- **Failure accounting uses the MCP server's error messages.** The bot recognizes the unbilled cases by their fixed messages ("Input validation error", "Invalid request", "not found in the database", and so on). Any message it does not recognize counts as possibly billed, which can overcount but never undercounts.
- **The agent's count rule is per kind, not per filter.** Outside lookalike and semantic company searches, any nonzero `count_people` earlier in the question allows a people search, even if Claude changes the filters afterwards.
- **Approvals live in memory.** A restart forgets pending approvals; a later click says the request expired and nothing is charged. The ledger is a JSON file for a single process, so run one instance, or move it to a shared store.
- **No paging carry-over.** Running `/ce people` twice buys the same first page twice. People search cannot exclude people already seen. Narrow with role words or a date filter instead.
- **Two dependency overrides** in `package.json`:
  - `@modelcontextprotocol/server` is pinned to 2.4.0 under `@companyenrich/mcp`. This bot uses only stdio, and the server was verified live with 2.4.0.
  - `undici`, a peer dependency that Bolt pulls in through `@slack/socket-mode`, is pinned to 7.x. Loading undici 8 replaced Node's global HTTP dispatcher, and on Node 26 the built-in `fetch` then stopped decoding gzip and brotli responses, which broke every API client in the process. `test/runtime.test.ts` guards against this.

## Ideas to extend it

- Store approvals and the ledger in Redis or Postgres, so several instances can share caps and pending clicks.
- Add a `/ce more` command that remembers the last search and fetches the next page instead of buying page 1 again.
- Let a channel admin approve spend for others, or set per-channel caps.
- Swap the stdio MCP server for the hosted one (`https://mcp.companyenrich.com/mcp`) using the MCP SDK's Streamable HTTP client, so the bot needs no child process.
- Post a weekly digest: run a saved question on a schedule and post only the companies that are new since last time.
