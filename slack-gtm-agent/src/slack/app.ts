import type { IncomingHttpHeaders } from 'node:http';
import { App, HTTPReceiver, LogLevel } from '@slack/bolt';
import { registerApprovalActions } from './actions.js';
import { registerCommands } from './commands.js';
import { registerMentions } from './mentions.js';
import { BackgroundWork, type BotServices } from './shared.js';

export interface SlackOptions {
  signingSecret: string;
  botToken: string;
  /** Web API base URL, for a local mock. Defaults to https://slack.com/api/. */
  apiUrl?: string;
  logLevel?: LogLevel;
}

/** Slack's rule: reject a request whose timestamp is more than 5 minutes from now, either way. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

export function isFreshTimestamp(headers: IncomingHttpHeaders, nowMs = Date.now()): boolean {
  const raw = headers['x-slack-request-timestamp'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) return false;
  return Math.abs(nowMs / 1000 - Number(value)) <= MAX_CLOCK_SKEW_SECONDS;
}

/**
 * The Bolt app in HTTP mode: Slack POSTs slash commands, events and button clicks to
 * /slack/events, and Bolt rejects any request whose signature does not match the
 * signing secret.
 */
export function createSlackApp(options: SlackOptions, services: BotServices): { app: App; idle: () => Promise<void> } {
  const logLevel = options.logLevel ?? LogLevel.INFO;
  const receiver = new HTTPReceiver({ signingSecret: options.signingSecret, logLevel });

  // Bolt rejects timestamps older than 5 minutes but accepts any future one, so a signed
  // request stamped tomorrow would stay replayable until then. Check both sides first.
  const verifyWithBolt = receiver.requestListener;
  receiver.requestListener = (request, response) => {
    if (!isFreshTimestamp(request.headers)) {
      response.writeHead(401).end();
      return;
    }
    verifyWithBolt(request, response);
  };

  const app = new App({
    receiver,
    token: options.botToken,
    logLevel,
    ...(options.apiUrl ? { clientOptions: { slackApiUrl: options.apiUrl } } : {}),
  });
  const work = new BackgroundWork(app.logger);

  registerCommands(app, services, work);
  registerMentions(app, services, work);
  registerApprovalActions(app, services);

  return { app, idle: () => work.idle() };
}
