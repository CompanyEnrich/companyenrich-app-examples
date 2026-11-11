/** An expected problem with the input; the CLI prints the message without a stack trace. */
export class UsageError extends Error {
  override name = 'UsageError';
}
