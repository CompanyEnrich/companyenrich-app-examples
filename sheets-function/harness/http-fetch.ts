/**
 * A UrlFetchApp stand-in backed by real HTTP, for the live smoke tests.
 * Apps Script's UrlFetchApp blocks until the response arrives; Node's fetch
 * is asynchronous, so each call runs fetch-worker.mjs in a child process with
 * spawnSync and waits for it.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FakeHttpResponse, type UrlFetchParams } from './fakes.js';

const WORKER = fileURLToPath(new URL('./fetch-worker.mjs', import.meta.url));

export interface HttpLogEntry {
  method: string;
  path: string;
  status: number;
  body: string;
}

type WireResponse = { status: number; headers: Record<string, string>; body: string } | { error: string };

/** Every request is also appended to `log`, so the smoke tests can report what they called. */
export function createHttpUrlFetchApp(log: HttpLogEntry[] = []) {
  function send(requests: Array<UrlFetchParams & { url: string }>): FakeHttpResponse[] {
    const wire = requests.map((request) => ({
      url: request.url,
      method: (request.method ?? 'get').toUpperCase(),
      headers: {
        ...request.headers,
        ...(request.contentType ? { 'Content-Type': request.contentType } : {}),
      },
      body: request.payload,
    }));
    const child = spawnSync(process.execPath, [WORKER], {
      input: JSON.stringify(wire),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (child.status !== 0) throw new Error(`fetch worker failed: ${child.stderr || child.error?.message}`);
    const responses = JSON.parse(child.stdout) as WireResponse[];

    return responses.map((response, index) => {
      const request = requests[index]!;
      // Like UrlFetchApp, a network failure throws even with muteHttpExceptions.
      if ('error' in response) throw new Error(`Exception: ${response.error}`);
      log.push({
        method: wire[index]!.method,
        path: new URL(request.url).pathname,
        status: response.status,
        body: response.body,
      });
      if (response.status >= 400 && !request.muteHttpExceptions) {
        throw new Error(`Request failed for ${request.url} returned code ${response.status}`);
      }
      return new FakeHttpResponse(response.status, response.body, response.headers);
    });
  }

  return {
    fetch: (url: string, params: UrlFetchParams = {}) => send([{ ...params, url }])[0]!,
    fetchAll: (requests: Array<UrlFetchParams & { url: string }>) => send(requests),
  };
}
