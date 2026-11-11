// @ts-check
// Reads a JSON array of requests on stdin, sends them in parallel with fetch,
// and prints a JSON array of responses. http-fetch.ts runs this with
// spawnSync, which gives the blocking behaviour of Apps Script's UrlFetchApp.
// The API key travels in stdin, never on a command line.

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

/** @type {Array<{url: string, method: string, headers: Record<string, string>, body?: string}>} */
const requests = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const responses = await Promise.all(
  requests.map(async (request) => {
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      return { error: `${error instanceof Error ? error.message : String(error)}${cause}` };
    }
  }),
);

process.stdout.write(JSON.stringify(responses));
