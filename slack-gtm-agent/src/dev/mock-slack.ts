import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the bot made to "Slack". */
export interface SlackTraffic {
  kind: 'api' | 'respond' | 'upload';
  /** Web API method (`chat.postMessage`), response_url id, or uploaded file id. */
  target: string;
  body: Record<string, unknown>;
}

/**
 * A local stand-in for Slack, so the bot can run without a workspace. It answers the
 * Web API methods the bot uses (point Bolt's `slackApiUrl` at `apiUrl`), receives
 * `response_url` follow-ups at `responseUrl(id)`, and accepts file uploads. Every
 * request is recorded in `traffic`.
 */
export class MockSlack {
  readonly traffic: SlackTraffic[] = [];
  private readonly listeners = new Set<(traffic: SlackTraffic) => void>();
  private readonly server = http.createServer((request, response) => {
    this.handle(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  private baseUrl = '';
  private counter = 0;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get apiUrl(): string {
    return `${this.baseUrl}/api/`;
  }

  responseUrl(id: string): string {
    return `${this.baseUrl}/respond/${id}`;
  }

  onTraffic(listener: (traffic: SlackTraffic) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolve with the first recorded or future request that matches. */
  waitFor(match: (traffic: SlackTraffic) => boolean, timeoutMs = 30_000): Promise<SlackTraffic> {
    const seen = this.traffic.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`No matching Slack request within ${timeoutMs} ms`));
      }, timeoutMs);
      // A pending wait must not keep the process alive on its own.
      timer.unref();
      const stop = this.onTraffic((traffic) => {
        if (!match(traffic)) return;
        clearTimeout(timer);
        stop();
        resolve(traffic);
      });
    });
  }

  private record(traffic: SlackTraffic): void {
    this.traffic.push(traffic);
    for (const listener of this.listeners) listener(traffic);
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const contentType = request.headers['content-type'] ?? '';
    const path = new URL(request.url ?? '/', this.baseUrl).pathname;

    if (path.startsWith('/api/')) {
      const method = path.slice('/api/'.length);
      const body = contentType.includes('json') ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : formBody(raw);
      this.record({ kind: 'api', target: method, body });
      sendJson(response, this.reply(method, body));
      return;
    }
    if (path.startsWith('/respond/')) {
      this.record({ kind: 'respond', target: path.slice('/respond/'.length), body: JSON.parse(raw.toString('utf8')) });
      sendJson(response, { ok: true });
      return;
    }
    if (path.startsWith('/upload/')) {
      // The Web API client posts the file as multipart form data in a field named "body".
      const form = await new Response(raw, { headers: { 'content-type': contentType } }).formData();
      const file = form.get('body');
      const content = file instanceof Blob ? await file.text() : String(file ?? '');
      this.record({ kind: 'upload', target: path.slice('/upload/'.length), body: { content } });
      response.writeHead(200, { 'content-type': 'text/plain' }).end('OK');
      return;
    }
    response.writeHead(404).end();
  }

  private reply(method: string, body: Record<string, unknown>): Record<string, unknown> {
    this.counter += 1;
    const ts = `1700000000.${String(this.counter).padStart(6, '0')}`;
    switch (method) {
      case 'auth.test':
        return { ok: true, url: 'https://local.slack.test/', team: 'Local', user: 'companyenrich', team_id: 'T0LOCAL', user_id: 'U0BOT', bot_id: 'B0BOT' };
      case 'chat.postMessage':
        return { ok: true, channel: body.channel, ts, message: { ts, text: body.text } };
      case 'chat.update':
        return { ok: true, channel: body.channel, ts: body.ts };
      case 'files.getUploadURLExternal': {
        const fileId = `F${String(this.counter).padStart(8, '0')}`;
        return { ok: true, upload_url: `${this.baseUrl}/upload/${fileId}`, file_id: fileId };
      }
      case 'files.completeUploadExternal':
        return { ok: true, files: body.files };
      default:
        return { ok: true };
    }
  }
}

/** Web API form bodies carry nested values (blocks, files) as JSON strings. */
function formBody(raw: Buffer): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(raw.toString('utf8'))) {
    body[key] = /^[[{]/.test(value) ? JSON.parse(value) : value;
  }
  return body;
}

function sendJson(response: http.ServerResponse, data: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}
