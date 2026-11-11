import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlanReport } from './planner.js';
import { renderHtml } from './report-html.js';

/** The routing file: territory -> rep -> states, with CompanyEnrich state ids and counts. */
export function assignmentJson(report: PlanReport): string {
  const body = {
    runId: report.runId,
    generatedAt: report.generatedAt,
    country: report.country,
    icp: report.icp,
    balancedOn: report.weightBy === 'none' ? 'companies' : report.weightBy,
    keepRegions: report.keepRegions,
    balance: report.balance,
    coverage: report.coverage,
    creditsSpent: report.credits.spent,
    territories: report.territories.map((territory) => ({
      territory: territory.number,
      rep: territory.rep,
      companies: territory.companies,
      weight: territory.weight,
      share: territory.share,
      states: territory.states,
      ...(territory.samples ? { sampleAccounts: territory.samples } : {}),
    })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One row per state, for spreadsheets and CRM territory rules. `weight` equals companies when unweighted. */
export function territoriesCsv(report: PlanReport): string {
  const header = ['territory', 'rep', 'state_id', 'state_code', 'state_name', 'icp_companies', 'weight'];
  const rows = report.territories.flatMap((territory) =>
    territory.states.map((state) => [
      territory.number,
      territory.rep,
      state.id,
      state.code,
      state.name,
      state.companies,
      Math.round(state.weight * 100) / 100,
    ]),
  );
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

export interface OutputPaths {
  dir: string;
  html: string;
  json: string;
  csv: string;
}

/** Writes report.html, assignment.json and territories.csv to `<outDir>/<runId>/`. */
export async function writeOutputs(report: PlanReport, outDir: string): Promise<OutputPaths> {
  const dir = join(outDir, report.runId);
  const paths = { dir, html: join(dir, 'report.html'), json: join(dir, 'assignment.json'), csv: join(dir, 'territories.csv') };
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(paths.html, renderHtml(report)),
    writeFile(paths.json, assignmentJson(report)),
    writeFile(paths.csv, territoriesCsv(report)),
  ]);
  return paths;
}
