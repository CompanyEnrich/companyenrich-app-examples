import Anthropic from '@anthropic-ai/sdk';
import { CompanyEnrich } from '@companyenrich/sdk';
import type { App, LogLevel } from '@slack/bolt';
import type { Config } from './config.js';
import { GtmAgent } from './lib/agent.js';
import { Approvals } from './lib/approvals.js';
import { Ledger } from './lib/budget.js';
import { countTools } from './lib/count-tools.js';
import { connectCompanyEnrichMcp } from './lib/mcp.js';
import { Toolbox } from './lib/toolbox.js';
import { redactPeople } from './dev/redact.js';
import { createSlackApp } from './slack/app.js';

export interface RunningBot {
  app: App;
  toolbox: Toolbox;
  agentEnabled: boolean;
  /** Resolves when no command or question is being worked on. */
  idle(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start everything: the CompanyEnrich MCP server (child process over stdio), the
 * toolbox around its tools, the optional Claude agent, and the Slack HTTP server.
 */
export async function startBot(
  config: Config,
  options: { logLevel?: LogLevel; /** Replace people's personal data, for local runs. */ redactPeople?: boolean } = {},
): Promise<RunningBot> {
  // Check the key with the free account call before starting anything else. The SDK
  // retries a rate limit on this free call and throws AuthenticationError for a bad key.
  const sdk = new CompanyEnrich({ apiKey: config.companyEnrichApiKey, timeoutMs: 30_000 });
  await sdk.me();

  const mcp = await connectCompanyEnrichMcp(config.companyEnrichApiKey);
  try {
    const toolbox = await Toolbox.create({
      mcp: options.redactPeople ? redactPeople(mcp.tools) : mcp.tools,
      localTools: countTools(sdk),
      ledger: new Ledger(config.ledgerFile),
      limits: config.limits,
    });
    const agent = config.anthropic
      ? new GtmAgent({ anthropic: new Anthropic({ apiKey: config.anthropic.apiKey }), toolbox, model: config.anthropic.model })
      : undefined;

    const { app, idle } = createSlackApp(
      { ...config.slack, ...(options.logLevel ? { logLevel: options.logLevel } : {}) },
      { toolbox, approvals: new Approvals(), ...(agent ? { agent } : {}) },
    );
    await app.start(config.port);

    return {
      app,
      toolbox,
      agentEnabled: Boolean(agent),
      idle,
      stop: async () => {
        await app.stop();
        await mcp.close();
      },
    };
  } catch (error) {
    await mcp.close();
    throw error;
  }
}
