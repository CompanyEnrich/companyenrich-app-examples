import type { App, webApi } from '@slack/bolt';
import { describeAgentError, type GtmAgent, type Plan } from '../lib/agent.js';
import { answerMessage, decisionMessage, errorMessage, noticeMessage, planMessage, type SlackMessage } from '../lib/blocks.js';
import { csvFilesFor, uploadCsv, type BackgroundWork, type BotServices } from './shared.js';

const AGENT_OFF =
  'Agent mode is off on this server because ANTHROPIC_API_KEY is not set. The `/ce` commands work without it: try `/ce help`.';

export function registerMentions(app: App, services: BotServices, work: BackgroundWork): void {
  const seen = new RecentKeys(500);

  app.event('app_mention', async ({ event, client }) => {
    const userId = event.user;
    // Slack can deliver an event twice; answering twice could spend credits twice.
    if (!userId || seen.has(`${event.channel}:${event.ts}`)) return;

    const threadTs = event.thread_ts ?? event.ts;
    const post = (message: SlackMessage) => client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, ...message });
    const question = event.text.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '').trim();

    const agent = services.agent;
    if (!agent) {
      await post(noticeMessage(AGENT_OFF));
      return;
    }
    if (!question) {
      await post(noticeMessage('Ask me a go-to-market question, for example "VPs of sales at Series B fintechs in Berlin?"'));
      return;
    }
    work.run(() => answer({ agent, services, client, post, question, userId, channelId: event.channel, threadTs }));
  });
}

async function answer(input: {
  agent: GtmAgent;
  services: BotServices;
  client: webApi.WebClient;
  post: (message: SlackMessage) => Promise<webApi.ChatPostMessageResponse>;
  question: string;
  userId: string;
  channelId: string;
  threadTs: string;
}): Promise<void> {
  const { agent, services, client, post, question, userId, channelId, threadTs } = input;
  await post(noticeMessage("On it. I'll show each plan and its credit estimate before anything paid runs."));

  try {
    const result = await agent.answer(question, userId, {
      showPlan: async (plan) => {
        await post(planMessage(plan));
      },
      requestApproval: async (plan: Plan) => {
        const summary = `Plan: ${plan.steps.length} paid step${plan.steps.length === 1 ? '' : 's'}, up to ${plan.estimate} credits.`;
        const { id, decision } = services.approvals.request(userId, summary);
        const posted = await post(planMessage(plan, id));
        const outcome = await decision;
        // Approve and Cancel replace the message themselves; an expiry has no click to do it.
        if (outcome === 'expired' && posted.ts) {
          await client.chat.update({ channel: channelId, ts: posted.ts, ...decisionMessage(summary, outcome, userId) });
        }
        return outcome;
      },
    });

    const files = csvFilesFor(result.rows, 'companyenrich');
    await post(answerMessage({ text: result.text, rows: result.rows, spent: result.spent, csvFiles: files.length }));
    for (const file of files) {
      try {
        await uploadCsv(client, file, { channelId, threadTs });
      } catch (error) {
        await post(errorMessage(`Could not attach ${file.filename}: ${describeAgentError(error)}`));
      }
    }
  } catch (error) {
    await post(errorMessage(describeAgentError(error)));
  }
}

/** A bounded set of recently seen keys, oldest dropped first. */
class RecentKeys {
  private readonly keys = new Set<string>();

  constructor(private readonly limit: number) {}

  /** True if the key was already seen; records it otherwise. */
  has(key: string): boolean {
    if (this.keys.has(key)) return true;
    this.keys.add(key);
    if (this.keys.size > this.limit) this.keys.delete(this.keys.values().next().value as string);
    return false;
  }
}
