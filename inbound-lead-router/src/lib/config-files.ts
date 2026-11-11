import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ConfigError, parseRoutingConfig, parseScoringConfig } from './config';
import type { PipelineConfig } from './pipeline';

// Config files are read on every request, so edits to config/*.json apply to
// the next lead without a restart or rebuild. They are tiny.

export const CONFIG_DIR = join(process.cwd(), 'config');

/** "config/scoring.json" for files under the app folder, the absolute path otherwise. */
function displayPath(file: string): string {
  const path = relative(process.cwd(), file);
  return path && !path.startsWith('..') ? path : file;
}

function readJson(file: string): unknown {
  const label = displayPath(file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read ${label}. Run the app from the inbound-lead-router folder.`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

export function loadPipelineConfig(paths: { scoring?: string; routing?: string } = {}): PipelineConfig {
  const scoringFile = paths.scoring ?? join(CONFIG_DIR, 'scoring.json');
  const routingFile = paths.routing ?? join(CONFIG_DIR, 'routing.json');
  return {
    scoring: parseScoringConfig(readJson(scoringFile), displayPath(scoringFile)),
    routing: parseRoutingConfig(readJson(routingFile), displayPath(routingFile)),
  };
}
