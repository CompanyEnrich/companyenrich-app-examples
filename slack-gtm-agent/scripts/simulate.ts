/**
 * Run the bot against a local mock of Slack and send it one signed request, the way
 * Slack would. Prints every reply the bot sends back.
 *
 *   npm run simulate -- "/ce count fintech startups in Berlin"
 *   npm run simulate -- "/ce people stripe.com vp sales 2" --approve
 *   npm run simulate -- "@companyenrich VPs of sales at Series B fintechs in Berlin?"
 *
 * --approve or --cancel clicks that button when the bot asks; --json prints raw Block Kit.
 * People's names, LinkedIn profile URLs and emails are replaced by placeholders unless
 * you pass --show-pii. Needs COMPANYENRICH_API_KEY. The bot listens on PORT (default 3000).
 */
import '../src/env.js';
import { LogLevel } from '@slack/bolt';
import { startBot } from '../src/bot.js';
import { loadConfig } from '../src/config.js';
import { MockSlack, type SlackTraffic } from '../src/dev/mock-slack.js';
import { appMentionBody, buttonClickBody, postSigned, slashCommandBody } from '../src/dev/signing.js';
import { ACTION_APPROVE, ACTION_CANCEL, blocksToText, type Block } from '../src/lib/blocks.js';
import { describeError } from '../src/lib/errors.js';

const SIGNING_SECRET = 'local-simulator-signing-secret';
const USER_ID = 'U0LOCALUSER';
const CHANNEL_ID = 'C0LOCAL';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const input = args.filter((arg) => !arg.startsWith('--')).join(' ').trim();
const click = flags.has('--cancel') ? ACTION_CANCEL : flags.has('--approve') ? ACTION_APPROVE : undefined;

if (!input) {
  console.error('Usage: npm run simulate -- "/ce company stripe.com" [--approve|--cancel] [--json] [--show-pii]');
  process.exit(1);
}

const slack = new MockSlack();
await slack.start();
slack.onTraffic(print);

try {
  const config = loadConfig({
    ...process.env,
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_TOKEN: 'xoxb-local-simulator',
    SLACK_API_URL: slack.apiUrl,
  });
  const showPii = flags.has('--show-pii');
  const bot = await startBot(config, { logLevel: LogLevel.WARN, redactPeople: !showPii });
  const eventsUrl = `http://localhost:${config.port}/slack/events`;
  console.log(`Bot on ${eventsUrl}, mock Slack on ${slack.apiUrl}, agent mode ${bot.agentEnabled ? 'on' : 'off'}.`);
  if (!showPii) console.log("People's names, LinkedIn profiles and emails are redacted. Pass --show-pii to see them.");

  const response = input.startsWith('/ce')
    ? await postSigned(
        eventsUrl,
        SIGNING_SECRET,
        slashCommandBody({ text: input.replace(/^\/ce\s*/, ''), userId: USER_ID, channelId: CHANNEL_ID, responseUrl: slack.responseUrl('command') }),
        'application/x-www-form-urlencoded',
      )
    : await postSigned(
        eventsUrl,
        SIGNING_SECRET,
        appMentionBody({ text: input.replace(/^@\S+\s*/, '<@U0BOT> '), userId: USER_ID, channelId: CHANNEL_ID, ts: '1700000000.000001' }),
        'application/json',
      );
  console.log(`Signed request: POST /slack/events -> HTTP ${response.status}`);

  // Every request produces at least one reply; after that, run until the bot is idle,
  // clicking the requested button each time it asks for approval.
  await slack.waitFor(isReply, 120_000);
  const handled = new Set<SlackTraffic>();
  for (;;) {
    const prompt = slack.waitFor((traffic) => !handled.has(traffic) && buttonValue(traffic, ACTION_APPROVE) !== undefined, 30 * 60_000);
    const next = await Promise.race([bot.idle().then(() => undefined), prompt]);
    if (!next) break;
    handled.add(next);
    if (!click) {
      console.log('\nWaiting for approval. Run again with --approve or --cancel to click a button.');
      break;
    }
    console.log(`\n>>> Clicking ${click === ACTION_APPROVE ? 'Approve' : 'Cancel'} as ${USER_ID}`);
    await postSigned(
      eventsUrl,
      SIGNING_SECRET,
      buttonClickBody({ actionId: click, value: buttonValue(next, click) ?? '', userId: USER_ID, channelId: CHANNEL_ID, responseUrl: slack.responseUrl('click') }),
      'application/x-www-form-urlencoded',
    );
  }
  await bot.stop();
} catch (error) {
  console.error(`simulate: ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  await slack.stop();
}

function isReply(traffic: SlackTraffic): boolean {
  return traffic.kind === 'respond' || (traffic.kind === 'api' && traffic.target === 'chat.postMessage');
}

function blocksOf(traffic: SlackTraffic): Block[] {
  return Array.isArray(traffic.body.blocks) ? (traffic.body.blocks as Block[]) : [];
}

function buttonValue(traffic: SlackTraffic, actionId: string): string | undefined {
  for (const block of blocksOf(traffic)) {
    if (block.type !== 'actions') continue;
    for (const element of block.elements) {
      if (element.type === 'button' && element.action_id === actionId) return element.value;
    }
  }
  return undefined;
}

function print(traffic: SlackTraffic): void {
  if (traffic.kind === 'upload') {
    const content = String(traffic.body.content);
    const lines = content.trim().split('\r\n');
    console.log(`\n=== CSV file uploaded: ${lines.length - 1} rows ===\n${lines.slice(0, 3).join('\n')}\n...`);
    return;
  }
  if (traffic.kind === 'api' && traffic.target !== 'chat.postMessage' && traffic.target !== 'chat.update') return;

  const where =
    traffic.kind === 'respond'
      ? `response_url, ${String(traffic.body.response_type ?? (traffic.body.replace_original ? 'replaces the prompt' : 'ephemeral'))}`
      : `${traffic.target}${traffic.body.thread_ts ? ' in thread' : ''}`;
  console.log(`\n=== ${where} ===`);
  console.log(flags.has('--json') ? JSON.stringify(traffic.body.blocks ?? traffic.body, null, 2) : blocksToText(blocksOf(traffic)) || String(traffic.body.text));
}
