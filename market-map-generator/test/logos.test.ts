import { describe, expect, it } from 'vitest';
import { fetchLogos, initials, readAtMost } from '../src/lib/logos.ts';
import { renderHtml } from '../src/lib/render/html.ts';
import { renderSvg } from '../src/lib/render/svg.ts';
import { category, COMPANIES, fakeLogoServer, makeCompany, PNG } from './fixtures.ts';

/** A 2 MiB body served in 64 KiB chunks, only as fast as it is read. Records how much was pulled. */
function hugeBody() {
  const stats = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(64 * 1024);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (stats.pulled >= 2 * 1024 * 1024) return controller.close();
        stats.pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
}

describe('fetchLogos', () => {
  it('embeds reachable logos as data URIs and skips missing ones', async () => {
    const [first, second] = COMPANIES as [typeof COMPANIES[0], typeof COMPANIES[0]];
    const server = fakeLogoServer([first.logoUrl]);
    const logos = await fetchLogos([first, second], { fetch: server.fetch });
    expect(logos.get(first.id)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(logos.has(second.id)).toBe(false);
  });

  it('never sends an API key to the logo host', async () => {
    const server = fakeLogoServer(COMPANIES.map((company) => company.logoUrl));
    await fetchLogos(COMPANIES, { fetch: server.fetch });
    expect(server.requests).toHaveLength(COMPANIES.length);
    expect(server.requests.every((request) => !request.headers.has('authorization'))).toBe(true);
  });

  it('rejects responses that are not images, are too large, or fail', async () => {
    const company = COMPANIES[0]!;
    const respond = (response: Response | Error) => async () => {
      if (response instanceof Error) throw response;
      return response;
    };
    const cases = [
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      new Response(new Uint8Array(200_000), { headers: { 'content-type': 'image/png' } }),
      new Response(PNG, { status: 500, headers: { 'content-type': 'image/png' } }),
      new TypeError('fetch failed'),
    ];
    for (const response of cases) {
      const logos = await fetchLogos([company], { fetch: respond(response) as typeof fetch });
      expect(logos.size).toBe(0);
    }
  });

  it('stops reading a body as soon as it passes the size limit', async () => {
    const { stream, stats } = hugeBody();
    const bytes = await readAtMost(new Response(stream, { headers: { 'content-type': 'image/png' } }), 150_000);
    expect(bytes).toBeNull();
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThanOrEqual(150_000 + 64 * 1024);
  });

  it('refuses a declared content-length over the limit without reading the body', async () => {
    const { stream, stats } = hugeBody();
    const response = new Response(stream, { headers: { 'content-type': 'image/png', 'content-length': String(2 * 1024 * 1024) } });
    const logos = await fetchLogos([COMPANIES[0]!], { fetch: (async () => response) as typeof fetch });
    expect(logos.size).toBe(0);
    expect(stats.pulled).toBe(0);
    expect(stats.cancelled).toBe(true);
  });

  it('only ever uses SVG logos as image sources, never as inline markup', async () => {
    const company = COMPANIES[0]!;
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://tracker.example/x.png"/></svg>';
    const fetchSvg = (async () => new Response(hostile, { headers: { 'content-type': 'image/svg+xml' } })) as typeof fetch;
    const logos = await fetchLogos([company], { fetch: fetchSvg });
    const dataUri = logos.get(company.id)!;
    expect(dataUri).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);

    const map = { title: 'T', query: 'q', generatedOn: '2026-11-11', categories: [category('A', [company])], logos, method: 'm' };
    const html = renderHtml(map);
    const svg = renderSvg(map);
    for (const output of [html, svg]) {
      expect(output).not.toMatch(/<script/i);
      expect(output).not.toContain('tracker.example');
    }
    expect(html).toContain(`<img class="logo" src="${dataUri}"`);
    expect(svg).toContain(`<image href="${dataUri}"`);
  });

  it('skips logo URLs that are not https', async () => {
    const server = fakeLogoServer(['http://insecure.example/logo.png']);
    const logos = await fetchLogos([makeCompany('Plain', 'x', { logoUrl: 'http://insecure.example/logo.png' })], { fetch: server.fetch });
    expect(logos.size).toBe(0);
    expect(server.requests).toHaveLength(0);
  });

  it('runs at most four downloads at a time', async () => {
    let active = 0;
    let peak = 0;
    const slowFetch = (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    const logos = await fetchLogos(COMPANIES, { fetch: slowFetch });
    expect(logos.size).toBe(COMPANIES.length);
    expect(peak).toBe(4);
  });
});

describe('initials', () => {
  it('uses the first letters of two words, or two letters of one', () => {
    expect(initials('Acme Robotics')).toBe('AR');
    expect(initials('Ledgerly')).toBe('LE');
    expect(initials('FINA AI')).toBe('FA');
    expect(initials('***')).toBe('?');
  });
});
