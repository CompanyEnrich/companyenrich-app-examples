import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Bolt pulls in `undici` (a peer dependency of @slack/socket-mode), which installs its own
 * global dispatcher when loaded. With undici 8 on Node 26, the built-in fetch then stopped
 * decoding compressed responses, breaking every API client in the process. package.json
 * pins undici 7 through `overrides`; this test guards that.
 */
describe('fetch after loading Bolt', () => {
  const body = JSON.stringify({ ok: true, credits: { used: 1, total: 2 } });
  const server = http.createServer((request, response) => {
    const encoding = request.url === '/br' ? 'br' : 'gzip';
    const data = encoding === 'br' ? brotliCompressSync(body) : gzipSync(body);
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding }).end(data);
  });
  let base = '';

  beforeAll(async () => {
    await import('@slack/bolt');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it.each(['gzip', 'br'])('still decodes %s responses', async (encoding) => {
    const response = await fetch(`${base}/${encoding}`);
    await expect(response.json()).resolves.toEqual(JSON.parse(body));
  });
});
