import { buildCoverage } from '@/lib/coverage';
import { blueprintFromDescription, choosePreset } from '@/lib/describe';
import { parseDomainList } from '@/lib/domains';
import { createClaudeDrafter } from '@/lib/llm';
import { errorResponse, readJson, serverClient } from '@/server/http';
import { coverageRequest } from '@/server/schemas';

/**
 * POST /api/coverage { domains, preset | description }
 * Step 1, free: picks the committee and counts matching people per account and role.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJson(request, coverageRequest);
    const domains = parseDomainList(body.domains);
    const client = serverClient();

    const choice = body.preset
      ? choosePreset(body.preset)
      : await blueprintFromDescription(body.description!, { client, drafter: createClaudeDrafter() });
    const plan = await buildCoverage(client, domains, choice.blueprint);
    const { credits } = await client.me();

    return Response.json({ notes: choice.notes, source: choice.source, plan, credits });
  } catch (error) {
    return errorResponse(error);
  }
}
