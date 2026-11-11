/** Runs at most `max` tasks at once. Later tasks wait in arrival order. */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active += 1;
    // A finishing task hands its slot straight to the next waiter, so a newcomer
    // cannot slip in between and push the count over `max`.
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
