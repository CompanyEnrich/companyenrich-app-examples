import { plural } from './format.js';

export interface Signal {
  /** Bold lead: the company name, or the person's name for people signals. */
  title: string;
  /** The company the signal is about. */
  domain: string;
  summary: string;
  /** Extra lines, one per change, for account changes. */
  details: string[];
  link: { label: string; url: string };
}

export interface WatcherReport {
  id: string;
  type: string;
  title: string;
  signals: Signal[];
  notes: string[];
  creditsCharged: number;
  error?: string;
}

export interface Digest {
  date: string;
  reports: WatcherReport[];
  creditsCharged: number;
  maxCredits: number;
}

export function signalCount(digest: Digest): number {
  return digest.reports.reduce((total, report) => total + report.signals.length, 0);
}

export function summaryLine(digest: Digest): string {
  const signals = signalCount(digest);
  const lead = signals === 0 ? 'No new signals' : plural(signals, 'new signal');
  return `${lead} from ${plural(digest.reports.length, 'watcher')}. Credits used: ${digest.creditsCharged} (cap ${digest.maxCredits}).`;
}

export function renderMarkdown(digest: Digest): string {
  const lines = [`# GTM signals: ${digest.date}`, '', summaryLine(digest)];
  for (const report of digest.reports) {
    lines.push('', `## ${report.title} (\`${report.id}\`)`, '');
    if (report.error) lines.push(`**Error:** ${report.error}`, '');
    if (report.signals.length === 0 && !report.error) lines.push('No new signals.', '');
    for (const signal of report.signals) {
      lines.push(`- **${signal.title}**: ${signal.summary} ([${signal.link.label}](${signal.link.url}))`);
      for (const detail of signal.details) lines.push(`  - ${detail}`);
    }
    if (report.signals.length > 0) lines.push('');
    for (const note of report.notes) lines.push(`_${note}_`);
    while (lines.at(-1) === '') lines.pop();
  }
  return `${lines.join('\n')}\n`;
}
