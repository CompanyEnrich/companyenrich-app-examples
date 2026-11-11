/** An expected problem with the input or the budget. The CLI prints the message without a stack trace. */
export class UsageError extends Error {
  override name = 'UsageError';
}
