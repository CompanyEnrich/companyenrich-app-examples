import { randomUUID } from 'node:crypto';

export type Decision = 'approved' | 'cancelled' | 'expired';

interface Pending {
  userId: string;
  summary: string;
  settle: (decision: Decision) => void;
  timer: NodeJS.Timeout;
}

export type ResolveOutcome =
  | { status: 'ok'; summary: string }
  | { status: 'not-found' }
  | { status: 'not-owner'; ownerId: string };

/**
 * Paid steps waiting for an Approve or Cancel click.
 *
 * The button only carries a random id. What will run, and for how many credits, stays
 * in server memory, so a forged click cannot change the arguments. Only the user who
 * asked can approve, and a request expires after `ttlMs`. Pending requests do not
 * survive a restart: a click after one gets "expired".
 */
export class Approvals {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly ttlMs = 15 * 60_000) {}

  request(userId: string, summary: string): { id: string; decision: Promise<Decision> } {
    const id = randomUUID();
    const decision = new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => this.settle(id, 'expired'), this.ttlMs);
      timer.unref();
      this.pending.set(id, { userId, summary, settle: resolve, timer });
    });
    return { id, decision };
  }

  resolve(id: string, userId: string, decision: 'approved' | 'cancelled'): ResolveOutcome {
    const entry = this.pending.get(id);
    if (!entry) return { status: 'not-found' };
    if (entry.userId !== userId) return { status: 'not-owner', ownerId: entry.userId };
    this.settle(id, decision);
    return { status: 'ok', summary: entry.summary };
  }

  get size(): number {
    return this.pending.size;
  }

  private settle(id: string, decision: Decision): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.settle(decision);
  }
}
