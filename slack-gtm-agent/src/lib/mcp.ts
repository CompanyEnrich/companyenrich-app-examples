import { createRequire } from 'node:module';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolClient, ToolDefinition, ToolResult } from './toolbox.js';

/**
 * Path to the official CompanyEnrich MCP server's stdio entry point. It is an npm
 * dependency, so its version is pinned by the lockfile and nothing is fetched at runtime
 * (unlike `npx -y @companyenrich/mcp`).
 */
export function companyEnrichMcpEntry(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('@companyenrich/mcp/package.json')), 'dist', 'stdio.js');
}

export interface McpConnection {
  tools: ToolClient;
  close(): Promise<void>;
}

/** Start the CompanyEnrich MCP server as a child process and connect to it over stdio. */
export async function connectCompanyEnrichMcp(apiKey: string): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [companyEnrichMcpEntry()],
    // The child gets a minimal environment plus the API key, not this process's secrets.
    env: { ...getDefaultEnvironment(), COMPANYENRICH_API_KEY: apiKey },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'slack-gtm-agent', version: '1.0.0' });
  await client.connect(transport);
  return { tools: toToolClient(client), close: () => client.close() };
}

/** Adapt an MCP SDK client to the two calls the toolbox needs. */
export function toToolClient(client: Client): ToolClient {
  return {
    async listTools() {
      const tools: ToolDefinition[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...(page.tools as ToolDefinition[]));
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = Array.isArray(result.content) ? result.content : [];
      return {
        content: content.flatMap((item) =>
          item.type === 'text' && typeof item.text === 'string' ? [{ type: 'text' as const, text: item.text }] : [],
        ),
        ...(result.structuredContent ? { structuredContent: result.structuredContent as Record<string, unknown> } : {}),
        ...(result.isError ? { isError: true } : {}),
      } satisfies ToolResult;
    },
  };
}
