import { rateLimitKey, type ApiRequest, type ApiResponse } from '../lib/http';

/** Adapts a framework-free handler to a Next.js route handler. */
export async function respond(request: Request, handler: (request: ApiRequest) => Promise<ApiResponse>): Promise<Response> {
  try {
    const clientKey = rateLimitKey(request.headers, process.env.TRUST_PROXY === '1');
    const result = await handler({ headers: request.headers, body: request.body, clientKey });
    return Response.json(result.body, { status: result.status, headers: result.headers });
  } catch (error) {
    console.error(error);
    return Response.json({ error: 'Internal error. See the server log.' }, { status: 500 });
  }
}
