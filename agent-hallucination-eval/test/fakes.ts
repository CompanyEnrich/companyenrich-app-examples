import Anthropic from '@anthropic-ai/sdk';
import { CompanyEnrich } from '@companyenrich/sdk';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: any;
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

function recordingFetch(handle: Handler) {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    return handle(request);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

/**
 * A CompanyEnrich client whose requests are answered by `routes`, keyed like `GET /v2/me`. Nothing touches
 * the network. The client keeps the SDK's default retries, so tests see what a real client would send.
 */
export function fakeCompanyEnrich(routes: Record<string, Handler>) {
  const { fetch, requests } = recordingFetch((request) => {
    const handler = routes[`${request.method} ${request.path}`];
    return handler ? handler(request) : jsonResponse({ title: 'Not Found', status: 404 }, 404);
  });
  return { client: new CompanyEnrich({ apiKey: 'test-key', fetch }), requests };
}

export type Reply = Partial<Anthropic.Beta.BetaMessage> & Pick<Anthropic.Beta.BetaMessage, 'content' | 'stop_reason'>;

/** An Anthropic client that answers each request with the next scripted reply, or with `replies(body)`. */
export function fakeAnthropic(replies: Reply[] | ((body: any) => Reply)) {
  let count = 0;
  const { fetch, requests } = recordingFetch((request) => {
    const reply = typeof replies === 'function' ? replies(request.body) : replies[count];
    count += 1;
    if (!reply) return jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'no reply scripted' } }, 400);
    return jsonResponse({
      id: `msg_${count}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5 },
      ...reply,
    });
  });
  return { client: new Anthropic({ apiKey: 'test-key', fetch, maxRetries: 0 }), requests };
}

/** A final answer as the model would return it under structured outputs. */
export function answerText(answer: string, confidence: number): Reply {
  return { content: [{ type: 'text', text: JSON.stringify({ answer, confidence }), citations: null }], stop_reason: 'end_turn' };
}
