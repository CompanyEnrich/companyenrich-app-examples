import type { Limits } from './lib/budget.js';
import { DEFAULT_MODEL } from './lib/agent.js';

export interface Config {
  port: number;
  companyEnrichApiKey: string;
  slack: {
    signingSecret: string;
    botToken: string;
    /** Web API base URL. Only set it to point the bot at a local mock. */
    apiUrl?: string;
  };
  /** Present when ANTHROPIC_API_KEY is set; enables agent mode. */
  anthropic?: { apiKey: string; model: string };
  limits: Limits;
  ledgerFile: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const REQUIRED = ['COMPANYENRICH_API_KEY', 'SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN'] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new ConfigError(`Missing ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  }
  const value = (name: (typeof REQUIRED)[number]) => env[name]?.trim() ?? '';
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();

  return {
    port: wholeNumber(env, 'PORT', 3000),
    companyEnrichApiKey: value('COMPANYENRICH_API_KEY'),
    slack: {
      signingSecret: value('SLACK_SIGNING_SECRET'),
      botToken: value('SLACK_BOT_TOKEN'),
      ...(env.SLACK_API_URL?.trim() ? { apiUrl: env.SLACK_API_URL.trim() } : {}),
    },
    ...(anthropicKey ? { anthropic: { apiKey: anthropicKey, model: env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL } } : {}),
    limits: {
      approvalThreshold: wholeNumber(env, 'CE_APPROVAL_THRESHOLD', 10),
      questionCap: wholeNumber(env, 'CE_QUESTION_CAP', 50),
      dailyUserCap: wholeNumber(env, 'CE_DAILY_USER_CAP', 200),
      dailyTotalCap: wholeNumber(env, 'CE_DAILY_TOTAL_CAP', 1000),
    },
    ledgerFile: env.CE_LEDGER_FILE?.trim() || 'state/ledger.json',
  };
}

function wholeNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number, got "${raw}".`);
  return Number(raw);
}
