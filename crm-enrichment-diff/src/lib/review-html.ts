import { readFileSync } from 'node:fs';
import { PATCH_COLUMNS } from './patch.js';
import { STATUS_LABELS } from './report.js';
import { REASON_LABELS } from './rules.js';
import type { DiffCell, RecordSummary } from './types.js';

export interface ReviewData {
  runId: string;
  generatedAt: string;
  input: string;
  columns: string[];
  cells: DiffCell[];
  records: RecordSummary[];
}

// The browser code lives in real files next to this module so it can be read and linted as
// JavaScript and CSS. They are inlined, which keeps review.html a single self-contained file.
const asset = (name: string): string => readFileSync(new URL(`../review/${name}`, import.meta.url), 'utf8');

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** JSON that is safe inside a <script> element: escaping `<` rules out `</script>` and `<!--`. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderReviewHtml(data: ReviewData): string {
  const payload = {
    ...data,
    patchColumns: PATCH_COLUMNS,
    reasonLabels: REASON_LABELS,
    statusLabels: STATUS_LABELS,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enrichment review ${escapeHtml(data.runId)}</title>
<style>
${asset('styles.css')}</style>
</head>
<body>
<main>
  <header class="page-header">
    <div>
      <h1>Enrichment review</h1>
      <p class="meta">Run <code>${escapeHtml(data.runId)}</code> · <code>${escapeHtml(data.input)}</code> · ${data.records.length} records · generated ${escapeHtml(data.generatedAt)}</p>
    </div>
    <div class="export">
      <p id="approved-count" aria-live="polite"></p>
      <button id="export" class="primary" type="button">Export approved patch</button>
    </div>
  </header>

  <section class="stats" id="stats" aria-label="Totals"></section>

  <section class="toolbar" aria-label="Filters">
    <fieldset id="filter-change"><legend>Change type</legend></fieldset>
    <label><span>Field</span><select id="filter-column"><option value="">All fields</option></select></label>
    <label><span>Action</span><select id="filter-action"><option value="">All actions</option></select></label>
    <label><span>Company</span><input id="filter-search" type="search" placeholder="Name, domain or record ID"></label>
    <div class="bulk">
      <button id="approve-visible" type="button">Approve visible</button>
      <button id="reject-visible" type="button">Reject visible</button>
      <button id="reset" type="button">Reset to proposed</button>
    </div>
  </section>

  <p class="hint">Proposed updates start approved and review items start unapproved. Protected cells cannot be approved. The export contains every approved change, including ones hidden by the filters.</p>

  <div class="table-wrap">
    <table>
      <caption class="visually-hidden">Cell-level differences between the CRM export and CompanyEnrich</caption>
      <thead>
        <tr><th scope="col">Field</th><th scope="col">Change</th><th scope="col">CRM value</th><th scope="col">CompanyEnrich value</th><th scope="col">Will write</th><th scope="col">Action</th><th scope="col">Approve</th></tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <p id="empty" class="hint" hidden>No cells match these filters.</p>
  <p id="truncated" class="hint" hidden></p>

  <section id="unmatched" hidden>
    <h2>Records that were not diffed</h2>
    <ul id="unmatched-list"></ul>
  </section>
</main>
<script type="application/json" id="review-data">${embedJson(payload)}</script>
<script>
${asset('app.js')}</script>
</body>
</html>
`;
}
