// The company handler as a Cloudflare Worker. In wrangler.toml set
// `main = "examples/cloudflare-worker.ts"`, then store the key as a secret:
//   npx wrangler secret put COMPANYENRICH_API_KEY

import { cloudflareClientIp } from '../src/server/client-ip';
import { createCompanyHandler, type CompanyHandler } from '../src/server/handler';

interface Env {
  COMPANYENRICH_API_KEY: string;
}

// Module scope lives as long as the isolate, so the cache is shared by the
// requests that isolate serves (not across isolates or regions).
let handler: CompanyHandler | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/api/company') {
      return new Response('Not found', { status: 404 });
    }
    // Cloudflare sets CF-Connecting-IP itself, so clients cannot forge it.
    handler ??= createCompanyHandler({ apiKey: env.COMPANYENRICH_API_KEY, clientIp: cloudflareClientIp });
    return handler(request);
  },
};
