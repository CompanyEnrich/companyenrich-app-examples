import type { App, RespondFn, webApi } from '@slack/bolt';
import {
  approvalMessage,
  balanceMessage,
  companiesMessage,
  companyMessage,
  countMessage,
  errorMessage,
  escapeMrkdwn,
  helpMessage,
  noticeMessage,
  peopleMessage,
  type SlackMessage,
} from '../lib/blocks.js';
import { parseCommand, type Command } from '../lib/commands.js';
import { COST_RULES } from '../lib/costs.js';
import { describeError } from '../lib/errors.js';
import { describeFilter, peopleSearchArgs } from '../lib/filters.js';
import { companyRow, rowsFromResult, type Rows } from '../lib/rows.js';
import { resultText, type SpendContext, type ToolResult } from '../lib/toolbox.js';
import { csvFilesFor, uploadCsv, type BackgroundWork, type BotServices } from './shared.js';

interface CommandContext {
  userId: string;
  channelId: string;
  respond: RespondFn;
  client: webApi.WebClient;
  /** One spend context per command: the per-question cap applies to the whole command. */
  spend: SpendContext;
}

/** Results go to the channel; prompts, help and errors only to the person who typed the command. */
const toChannel = (message: SlackMessage) => ({ response_type: 'in_channel' as const, ...message });
const toUser = (message: SlackMessage) => ({ response_type: 'ephemeral' as const, ...message });

export function registerCommands(app: App, services: BotServices, work: BackgroundWork): void {
  app.command('/ce', async ({ command, ack, respond, client }) => {
    await ack();
    const context: CommandContext = {
      userId: command.user_id,
      channelId: command.channel_id,
      respond,
      client,
      spend: { userId: command.user_id, question: { spent: 0 } },
    };
    work.run(async () => {
      try {
        await runCommand(parseCommand(command.text), context, services);
      } catch (error) {
        await respond(toUser(errorMessage(describeError(error))));
      }
    });
  });
}

async function runCommand(command: Command, context: CommandContext, services: BotServices): Promise<void> {
  const { toolbox } = services;
  const { respond, spend } = context;

  switch (command.kind) {
    case 'help': {
      const pricing = toolbox.definitions.map((definition) => ({
        tool: definition.name,
        pricing: COST_RULES[definition.name]?.pricing ?? '',
      }));
      await respond(toUser(helpMessage(toolbox.limits, pricing)));
      return;
    }

    case 'invalid':
      await respond(toUser(errorMessage(command.message)));
      return;

    case 'balance': {
      const { result } = await toolbox.call('get_current_user', {}, spend);
      if (result.isError) return failed(respond, result);
      const credits = (result.structuredContent?.credits ?? {}) as { used?: number; total?: number };
      await respond(
        toUser(
          balanceMessage({
            used: credits.used ?? 0,
            total: credits.total ?? 0,
            spentToday: toolbox.spentToday(context.userId),
            limits: toolbox.limits,
          }),
        ),
      );
      return;
    }

    case 'company': {
      const { result, credits } = await toolbox.call('enrich_company', { domain: command.domain }, spend);
      if (result.isError) return failed(respond, result, credits);
      await respond(toChannel(companyMessage(companyRow(result.structuredContent), credits)));
      return;
    }

    case 'count': {
      const tool = command.target === 'people' ? 'count_people' : 'count_companies';
      const { result } = await toolbox.call(tool, { semanticQuery: command.query }, spend);
      if (result.isError) return failed(respond, result);
      const { count, total, interpretation } = countData(result);
      await respond(
        toChannel(
          countMessage({
            target: command.target,
            query: command.query,
            count,
            total,
            filters: interpretationLines(interpretation),
            boosts: describeFilter(record(interpretation).boost),
          }),
        ),
      );
      return;
    }

    case 'people': {
      const counted = await toolbox.call('count_people', { semanticQuery: command.roles, domains: [command.domain] }, spend);
      if (counted.result.isError) return failed(respond, counted.result);
      const { count, interpretation } = countData(counted.result);
      if (count === 0) {
        await respond(toUser(noticeMessage(`No one at ${command.domain} matches "${escapeMrkdwn(command.roles)}" (free count). Nothing to fetch, no credits spent.`)));
        return;
      }
      const pageSize = Math.min(command.limit, count);
      const search = peopleSearchArgs(command.domain, interpretation, pageSize);
      if (!search.ok) {
        await respond(toUser(errorMessage(`Not fetching: ${search.reason}. No credits spent.`)));
        return;
      }
      await approveThenFetch(context, services, {
        summary: `*${count}* ${count === 1 ? 'person' : 'people'} at ${command.domain} match _${escapeMrkdwn(command.roles)}_ (free count). Fetch ${pageSize}?`,
        details: search.filters.map((filter) => `The API read the role words as ${escapeMrkdwn(filter)}`),
        tool: 'search_people',
        args: search.args,
        title: `People at ${command.domain} matching "${command.roles}"`,
      });
      return;
    }

    case 'lookalikes': {
      const counted = await toolbox.call('count_companies', { lookalikeDomains: [command.domain] }, spend);
      if (counted.result.isError) return failed(respond, counted.result);
      const { count } = countData(counted.result);
      if (count === 0) {
        await respond(toUser(noticeMessage(`No lookalikes found for ${command.domain} (free count). Nothing to fetch, no credits spent.`)));
        return;
      }
      const pageSize = Math.min(command.limit, count);
      await approveThenFetch(context, services, {
        summary: `*${count.toLocaleString('en-US')}* companies are in the lookalike pool for ${command.domain} (free count). Fetch the ${pageSize} most similar?`,
        details: ['Ranked by similarity to the seed domain. Scores are not probabilities.'],
        tool: 'find_similar_companies',
        args: { domains: [command.domain], pageSize },
        title: `Companies similar to ${command.domain}`,
      });
      return;
    }
  }
}

/** Show the estimate with Approve and Cancel buttons; fetch only after Approve. */
async function approveThenFetch(
  context: CommandContext,
  services: BotServices,
  step: { summary: string; details: string[]; tool: string; args: Record<string, unknown>; title: string },
): Promise<void> {
  const { toolbox, approvals } = services;
  const { respond, spend } = context;

  const estimate = toolbox.estimate(step.tool, step.args);
  const check = toolbox.checkSpend(spend, estimate);
  if (!check.ok) {
    await respond(toUser(errorMessage(`Not fetching: ${check.reason}.`)));
    return;
  }

  const { id, decision } = approvals.request(context.userId, step.summary);
  await respond(toUser(approvalMessage({ summary: step.summary, details: step.details, estimate, pendingId: id })));
  // The click handler updates the prompt. Cancelled or expired requests end here.
  if ((await decision) !== 'approved') return;

  const { result, credits } = await toolbox.call(step.tool, step.args, { ...spend, approvedCredits: estimate });
  if (result.isError) return failed(respond, result, credits);

  const rows: Rows = rowsFromResult(step.tool, result.structuredContent);
  const files = csvFilesFor(rows, step.tool.replaceAll('_', '-'));
  const message =
    rows.people.length > 0
      ? peopleMessage(step.title, rows.people, credits, files.length > 0)
      : companiesMessage(step.title, rows.companies, credits, files.length > 0);
  await respond(toChannel(message));

  for (const file of files) {
    try {
      await uploadCsv(context.client, file, { channelId: context.channelId });
    } catch (error) {
      await respond(toUser(errorMessage(`Could not attach the CSV (${describeError(error)}). Invite the bot to this channel to get files.`)));
    }
  }
}

async function failed(respond: RespondFn, result: ToolResult, credits = 0): Promise<void> {
  const charged =
    credits > 0 ? ` Counted as ${credits} credits, because the call may have been billed before it failed.` : ' No credits were charged.';
  await respond(toUser(errorMessage(`${escapeMrkdwn(resultText(result))}${charged}`)));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function countData(result: ToolResult): { count: number; total: number; interpretation: unknown } {
  const data = result.structuredContent ?? {};
  return { count: Number(data.count ?? 0), total: Number(data.total ?? 0), interpretation: data.interpretation };
}

/** Person and company filters from a count's interpretation, as readable lines. */
function interpretationLines(interpretation: unknown): string[] {
  const reading = record(interpretation);
  const company = record(reading.company);
  const lines = describeFilter(reading.filter);
  if (Array.isArray(reading.companyNames) && reading.companyNames.length) lines.push(`company names: ${reading.companyNames.join(', ')}`);
  if (typeof company.query === 'string') lines.push(`company description: ${company.query}`);
  lines.push(...describeFilter(company.filter).map((line) => `company ${line}`));
  return lines;
}
