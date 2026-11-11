# Contributing an example

Each folder in this repo is a complete, self-contained app that someone can copy out and run on its own. New examples are welcome. To keep the bar consistent, every example has to meet the checklist below before it is merged.

## Layout

- One folder per app, named with a short kebab-case slug. The folder must not depend on any file outside itself.
- `package.json` with `"name"` set to the folder slug, `"private": true`, `"type": "module"` and `"engines": { "node": ">=22.12" }`. Commit the npm lockfile.
- TypeScript in strict mode. CLIs run with `tsx` (`npm start -- <args>`). Web apps use Next.js (App Router) and Tailwind CSS.
- Core logic lives in plain modules under `src/lib/` with no framework imports, so it can be tested and reused. The CLI or UI is a thin layer on top.
- `.env.example` lists every environment variable. `.gitignore` covers `node_modules`, `.env*`, build output and any generated data.

## Using the API

- Use the official SDK, [`@companyenrich/sdk`](https://www.npmjs.com/package/@companyenrich/sdk). Do not hand-roll HTTP calls.
- Build the client with `timeoutMs: 30_000`. Pass `{ maxRetries: 0 }` on paid GET calls (`companies.enrich`, `companies.workforce`, `people.findEmail`, `companies.get`, `people.get`) when the app enforces a credit cap, so the app decides when a paid call is repeated.
- Keep the API key on the server. In web apps every CompanyEnrich call goes through a route handler or server action, and the key never reaches the browser.
- Handle the SDK's typed errors (`AuthenticationError`, `PaymentRequiredError`, `NotFoundError`, `RateLimitError`, ...) with a one-line message. An expected condition must never print a stack trace.
- Cap concurrency at 4 with a single shared limiter.

## Cost safety

Credits are real money for the person running your example, so treat spend as a feature:

- Validate every input before the first paid call.
- Use the free endpoints first (`companies.count`, `people.count`, autocomplete, `geo`, `industries`) and skip a paid search when the count is 0.
- Show a credit estimate before spending. CLIs support `--max-credits` and `--dry-run` (free endpoints only, prints what a real run would cost). Web apps enforce the confirm step and the cap on the server, not only in the UI.
- Never pay twice for the same thing: cache lookups, exclude seen companies with `domain: { notIn: [...] }`, and resume capped runs where they stopped.
- Default page sizes are small. The default demo should cost well under 100 credits.

## LLM features

Optional only. The app must run end to end without `ANTHROPIC_API_KEY`, with a one-line notice that the LLM step is off. Use `@anthropic-ai/sdk`, test the LLM path with a mocked client, and follow the current [Claude API docs](https://docs.claude.com).

## Tests

- `npm ci && npm run typecheck && npm test` pass from a clean checkout with no network and no keys. Mock the SDK by passing a fake `fetch` to `new CompanyEnrich({ apiKey, fetch })`.
- Web apps also pass `npm run build`.
- Cover the spend paths: the estimate, the cap, the dry run, and that invalid input or a missing confirmation makes zero paid calls.

## README

Every example's README follows the same outline:

1. Title and a one-sentence pitch.
2. What it does, who it is for, and what it shows about the API.
3. **Example output**: real output from a live run, trimmed. Replace people's names, emails, LinkedIn URLs and photos with role placeholders such as `<VP Engineering>`. Also leave out anything that narrows a row down to one person: exact tenure or start dates, word-for-word headlines, unusual titles and locations. Executives whose roles are public, such as a CEO, are fine. Company data is fine.
4. **How it works**: numbered steps and a mermaid diagram.
5. **CompanyEnrich endpoints used**: SDK method, endpoint, why, cost.
6. **Quickstart**: three to five commands that work exactly as written.
7. **Configuration**: environment variables and flags or UI controls.
8. **Credits**: the cost of each step, the default demo total, and how to cap spend.
9. **Limitations**: honest caveats about the data and the approach.
10. **Ideas to extend it**.

State plainly what was tested live and what was tested with mocks (for example Slack, a CRM or Google Sheets). Never publish benchmark numbers you did not measure.

## Before you open a pull request

- [ ] Clean install, typecheck, tests (and build) pass.
- [ ] A live run of the default demo works, and the dry run or free mode spends 0 credits.
- [ ] A missing or bad key, an unknown domain and zero results each give a clear one-line message.
- [ ] No secrets, no `.env`, no generated output or state, and no real people's data in committed files.
- [ ] The README is complete and every command in it works.
- [ ] Add a row for your example to the table in the root `README.md`.
