import './env.js';
import { startBot } from './bot.js';
import { loadConfig } from './config.js';
import { describeError } from './lib/errors.js';

try {
  const config = loadConfig();
  const bot = await startBot(config);

  const tools = bot.toolbox.definitions.map((definition) => definition.name);
  console.log(`slack-gtm-agent is listening on http://localhost:${config.port}/slack/events`);
  console.log(`CompanyEnrich tools (MCP server plus free counts): ${tools.join(', ')}`);
  if (bot.toolbox.hidden.length) console.log(`Hidden, no cost rule: ${bot.toolbox.hidden.join(', ')}`);
  if (!bot.agentEnabled) {
    console.log('Agent mode is off: set ANTHROPIC_API_KEY to answer @mentions with Claude. /ce commands work without it.');
  }

  const shutdown = async () => {
    await bot.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(`slack-gtm-agent: ${describeError(error)}`);
  process.exit(1);
}
