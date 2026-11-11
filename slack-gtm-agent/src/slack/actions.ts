import type { App, BlockAction, ButtonAction, RespondFn } from '@slack/bolt';
import { ACTION_APPROVE, ACTION_CANCEL, decisionMessage, noticeMessage } from '../lib/blocks.js';
import type { BotServices } from './shared.js';

/** Approve and Cancel buttons, shared by command mode and agent mode. */
export function registerApprovalActions(app: App, services: BotServices): void {
  for (const [actionId, decision] of [
    [ACTION_APPROVE, 'approved'],
    [ACTION_CANCEL, 'cancelled'],
  ] as const) {
    app.action<BlockAction<ButtonAction>>(actionId, async ({ ack, action, body, respond }) => {
      await ack();
      await settle(services, respond, action.value ?? '', body.user.id, decision);
    });
  }
}

async function settle(
  services: BotServices,
  respond: RespondFn,
  pendingId: string,
  userId: string,
  decision: 'approved' | 'cancelled',
): Promise<void> {
  const outcome = services.approvals.resolve(pendingId, userId, decision);
  switch (outcome.status) {
    case 'ok':
      // Replace the prompt so its buttons cannot be clicked twice.
      await respond({ replace_original: true, ...decisionMessage(outcome.summary, decision, userId) });
      return;
    case 'not-owner':
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        ...noticeMessage(`Only <@${outcome.ownerId}> can approve or cancel this spend.`),
      });
      return;
    case 'not-found':
      await respond({
        replace_original: true,
        ...noticeMessage('This request expired or was already handled. Nothing more will be charged for it.'),
      });
      return;
  }
}
