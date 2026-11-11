import { createHmac } from 'node:crypto';

/**
 * Headers Slack sends with every request: an HMAC-SHA256 of `v0:<timestamp>:<body>`
 * keyed with the app's signing secret. Used to send test requests to a local bot.
 * See https://docs.slack.dev/authentication/verifying-requests-from-slack
 */
export function signSlackRequest(
  signingSecret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): Record<'x-slack-signature' | 'x-slack-request-timestamp', string> {
  const digest = createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex');
  return { 'x-slack-signature': `v0=${digest}`, 'x-slack-request-timestamp': String(timestamp) };
}

export interface SlashCommandInput {
  text: string;
  userId: string;
  channelId: string;
  responseUrl: string;
  command?: string;
}

export function slashCommandBody(input: SlashCommandInput): string {
  return new URLSearchParams({
    token: 'legacy-verification-token-unused',
    team_id: 'T0LOCAL',
    team_domain: 'local',
    channel_id: input.channelId,
    channel_name: 'gtm',
    user_id: input.userId,
    user_name: 'local-user',
    command: input.command ?? '/ce',
    text: input.text,
    api_app_id: 'A0LOCAL',
    response_url: input.responseUrl,
    trigger_id: '1.local',
  }).toString();
}

export function buttonClickBody(input: {
  actionId: string;
  value: string;
  userId: string;
  channelId: string;
  responseUrl: string;
}): string {
  const payload = {
    type: 'block_actions',
    user: { id: input.userId, username: 'local-user', team_id: 'T0LOCAL' },
    api_app_id: 'A0LOCAL',
    token: 'legacy-verification-token-unused',
    container: { type: 'message', message_ts: '1700000000.000100', channel_id: input.channelId, is_ephemeral: true },
    trigger_id: '2.local',
    team: { id: 'T0LOCAL', domain: 'local' },
    channel: { id: input.channelId, name: 'gtm' },
    response_url: input.responseUrl,
    actions: [
      {
        type: 'button',
        action_id: input.actionId,
        block_id: 'approval',
        value: input.value,
        text: { type: 'plain_text', text: input.actionId },
        action_ts: '1700000001.000200',
      },
    ],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

export function appMentionBody(input: { text: string; userId: string; channelId: string; ts: string }): string {
  return JSON.stringify({
    token: 'legacy-verification-token-unused',
    team_id: 'T0LOCAL',
    api_app_id: 'A0LOCAL',
    type: 'event_callback',
    event_id: `Ev${input.ts.replace('.', '')}`,
    event_time: Math.floor(Date.now() / 1000),
    event: {
      type: 'app_mention',
      user: input.userId,
      text: input.text,
      ts: input.ts,
      channel: input.channelId,
      event_ts: input.ts,
    },
  });
}

/** POST a signed request to a running bot. */
export async function postSigned(
  url: string,
  signingSecret: string,
  body: string,
  contentType: 'application/x-www-form-urlencoded' | 'application/json',
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': contentType, ...signSlackRequest(signingSecret, body) },
    body,
  });
}
