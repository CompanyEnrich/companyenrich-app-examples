import Anthropic from '@anthropic-ai/sdk';

export interface RecordedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown> & { messages: Array<{ role: string; content: unknown }> };
}

type Turn = (request: RecordedRequest) => { content: unknown[]; stop_reason: string };

export const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
export const text = (value: string) => ({ type: 'text', text: value });

/**
 * An Anthropic client whose `fetch` answers with scripted assistant turns instead of
 * calling the API. Every request is recorded for assertions.
 */
export function scriptedClaude(turns: Turn[]): { anthropic: Anthropic; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request: RecordedRequest = {
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as RecordedRequest['body'],
    };
    requests.push(request);
    const turn = turns[requests.length - 1];
    if (!turn) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'no scripted turn left' } }), { status: 400 });
    const message = {
      id: `msg_${requests.length}`,
      type: 'message',
      role: 'assistant',
      model: request.body.model,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
      ...turn(request),
    };
    return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json', 'request-id': `req_${requests.length}` } });
  };
  return { anthropic: new Anthropic({ apiKey: 'test-key', fetch, maxRetries: 0 }), requests };
}

/** The tool_result blocks Claude received in a request. */
export function toolResults(request: RecordedRequest): Array<{ tool_use_id: string; is_error?: boolean; text: string }> {
  const last = request.body.messages.at(-1);
  const blocks = Array.isArray(last?.content) ? (last.content as Array<Record<string, unknown>>) : [];
  return blocks
    .filter((block) => block.type === 'tool_result')
    .map((block) => ({
      tool_use_id: String(block.tool_use_id),
      ...(block.is_error ? { is_error: true } : {}),
      text: Array.isArray(block.content)
        ? (block.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n')
        : String(block.content),
    }));
}
