import { computeMetrics, metricsBy, type Metrics, type ScoredRow } from './metrics.ts';
import { TEMPLATES } from './questions.ts';

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function fieldOrder(rows: ScoredRow[]): string[] {
  const known = TEMPLATES.map((t) => t.field);
  const seen = [...new Set(rows.map((row) => row.field))];
  return [...known.filter((f) => seen.includes(f)), ...seen.filter((f) => !known.includes(f))];
}

function metricRow(label: string, m: Metrics): string[] {
  return [
    label,
    String(m.n),
    pct(m.accuracy),
    pct(m.partialRate),
    pct(m.hallucinationRate),
    pct(m.abstentionRate),
    m.confidenceWhenWrong === null ? '-' : m.confidenceWhenWrong.toFixed(2),
    String(m.errors),
  ];
}

const METRIC_HEADER = ['Questions', 'Accuracy', 'Partial', 'Hallucination', 'Abstention', 'Conf. when wrong', 'Errors'];

/** Field-by-run matrix of one metric, so adapters can be compared side by side. */
function matrix(rows: ScoredRow[], runs: string[], fields: string[], pick: (m: Metrics) => number): string {
  const cells = fields.map((field) => [
    field,
    ...runs.map((run) => {
      const group = rows.filter((row) => row.run === run && row.field === field);
      const m = computeMetrics(group);
      return m.n === 0 ? '-' : pct(pick(m));
    }),
  ]);
  return table(['Field', ...runs], cells);
}

export function renderReport(rows: ScoredRow[], files: string[], generatedAt: string): string {
  const runs = [...new Set(rows.map((row) => row.run))];
  const fields = fieldOrder(rows);
  const overall = metricsBy(rows, (row) => row.run);

  const sections = [
    '# Hallucination eval report',
    `Generated ${generatedAt} from ${files.map((f) => `\`${f}\``).join(', ')}.`,
    [
      '- **Accuracy**: the answer matches the gold value.',
      '- **Partial**: close but not exact (adjacent range bucket, year off by one, overlapping categories).',
      '- **Hallucination**: a wrong answer given instead of "unknown".',
      '- **Abstention**: the adapter answered "unknown".',
      '- **Conf. when wrong**: mean self-reported confidence (0 to 1) on hallucinated answers.',
      '- **Errors**: questions with no answer (API error, refusal, unparseable output), left out of every rate.',
    ].join('\n'),
    '## Overall',
    table(
      ['Run', ...METRIC_HEADER],
      runs.map((run) => metricRow(run, overall.get(run)!)),
    ),
    '## Hallucination rate by field',
    matrix(rows, runs, fields, (m) => m.hallucinationRate),
    '## Accuracy by field',
    matrix(rows, runs, fields, (m) => m.accuracy),
    ...runs.flatMap((run) => {
      const byField = metricsBy(
        rows.filter((row) => row.run === run),
        (row) => row.field,
      );
      return [
        `## ${run} by field`,
        table(
          ['Field', ...METRIC_HEADER],
          fields.filter((f) => byField.has(f)).map((f) => metricRow(f, byField.get(f)!)),
        ),
      ];
    }),
  ];
  return sections.join('\n\n') + '\n';
}

/** A short plain-text summary for the terminal. */
export function renderSummary(rows: ScoredRow[]): string {
  const overall = metricsBy(rows, (row) => row.run);
  return [...overall]
    .map(
      ([run, m]) =>
        `${run}: accuracy ${pct(m.accuracy)}, partial ${pct(m.partialRate)}, ` +
        `hallucination ${pct(m.hallucinationRate)}, abstention ${pct(m.abstentionRate)} (n=${m.n}, errors=${m.errors})`,
    )
    .join('\n');
}
