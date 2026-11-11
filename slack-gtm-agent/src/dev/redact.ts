import type { ToolClient, ToolResult } from '../lib/toolbox.js';

type Json = Record<string, unknown>;

/**
 * Wrap a tool client so people's names, photos, LinkedIn profile URLs and emails are
 * replaced before anything sees them. The local simulator uses this by default, so a
 * terminal log or a pasted example never contains personal data. A person's name
 * becomes their role, for example `<VP Sales>`.
 */
export function redactPeople(client: ToolClient): ToolClient {
  return {
    listTools: () => client.listTools(),
    callTool: async (name, args) => redactResult(await client.callTool(name, args)),
  };
}

export function redactResult(result: ToolResult): ToolResult {
  if (!result.structuredContent) return result;
  const structuredContent = redact(result.structuredContent) as Json;
  return { ...result, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
}

function isPerson(value: Json): boolean {
  return 'first_name' in value || 'last_name' in value || ('experiences' in value && 'position' in value);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const source = value as Json;
  const copy: Json = {};
  for (const [key, child] of Object.entries(source)) {
    if (typeof child === 'string' && /linkedin\.com\/in\//i.test(child)) copy[key] = '<linkedin-profile>';
    else if (key === 'email' && typeof child === 'string') copy[key] = '<email>';
    else copy[key] = redact(child);
  }
  if (isPerson(source)) {
    const role = typeof source.position === 'string' && source.position.trim() ? source.position.trim() : 'person';
    copy.name = `<${role}>`;
    delete copy.first_name;
    delete copy.last_name;
    delete copy.image_url;
  }
  return copy;
}
