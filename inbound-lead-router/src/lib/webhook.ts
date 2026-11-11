import { z } from 'zod';
import { ConfigError } from './config';
import { emailDomain } from './email';
import { UpstreamError } from './errors';
import { errorResponse, guard, readJsonBody, type ApiRequest, type ApiResponse, type GuardOptions } from './http';
import { processLead, type PipelineConfig, type PipelineDeps } from './pipeline';

// POST /api/inbound: validate, authenticate and rate-limit the request, then run the pipeline.

export const MAX_INBOUND_BODY_BYTES = 8 * 1024;

const leadSchema = z.object({
  email: z.string().trim().max(254).pipe(z.email()),
  name: z.string().trim().max(200).nullish(),
  source: z.string().trim().max(100).nullish(),
});

export interface InboundDeps extends GuardOptions {
  /** Reads config/scoring.json and config/routing.json; throws ConfigError when they are invalid. */
  loadConfig: () => PipelineConfig;
  pipeline: PipelineDeps;
}

export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
}

export async function handleInbound(request: ApiRequest, deps: InboundDeps): Promise<ApiResponse> {
  const blocked = guard(request, deps);
  if (blocked) return blocked;

  const body = await readJsonBody(request, MAX_INBOUND_BODY_BYTES);
  if (!body.ok) return body.response;

  const parsed = leadSchema.safeParse(body.value);
  if (!parsed.success) return errorResponse(400, `Invalid lead. ${describeIssues(parsed.error)}`);
  if (!emailDomain(parsed.data.email)) return errorResponse(400, 'Invalid lead. email: the domain is not a valid company domain');

  try {
    const trace = await processLead(parsed.data, deps.loadConfig(), deps.pipeline);
    return { status: 200, body: trace };
  } catch (error) {
    if (error instanceof UpstreamError) {
      return { status: 502, body: { error: error.message, ...(error.uncertainCredits ? { uncertainCredits: error.uncertainCredits } : {}) } };
    }
    if (error instanceof ConfigError) return errorResponse(500, error.message);
    throw error;
  }
}
