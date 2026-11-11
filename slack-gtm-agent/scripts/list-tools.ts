/**
 * Start the CompanyEnrich MCP server over stdio, list its tools next to the price this
 * bot enforces for each, and show the account balance. Uses only free calls.
 *
 *   npm run tools
 */
import '../src/env.js';
import { costRuleFor } from '../src/lib/costs.js';
import { connectCompanyEnrichMcp } from '../src/lib/mcp.js';
import { resultText } from '../src/lib/toolbox.js';

const apiKey = process.env.COMPANYENRICH_API_KEY?.trim();
if (!apiKey) {
  console.error('tools: set COMPANYENRICH_API_KEY (create one at https://companyenrich.com/dashboard).');
  process.exit(1);
}

const mcp = await connectCompanyEnrichMcp(apiKey);
try {
  const me = await mcp.tools.callTool('get_current_user', {});
  if (me.isError) throw new Error(resultText(me));

  const tools = await mcp.tools.listTools();
  console.log(`CompanyEnrich MCP server: ${tools.length} tools\n`);
  for (const tool of tools) {
    const rule = costRuleFor(tool.name);
    console.log(`${tool.name.padEnd(30)} ${rule ? rule.pricing : 'HIDDEN: no cost rule in src/lib/costs.ts'}`);
  }
  console.log('\nAdded by this bot (CompanyEnrich SDK, v2 count endpoints):');
  for (const name of ['count_companies', 'count_people']) console.log(`${name.padEnd(30)} ${costRuleFor(name)?.pricing}`);

  const credits = (me.structuredContent?.credits ?? {}) as { used?: number; total?: number };
  console.log(`\nAccount: ${credits.used} of ${credits.total} credits used.`);
} catch (error) {
  console.error(`tools: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await mcp.close();
}
