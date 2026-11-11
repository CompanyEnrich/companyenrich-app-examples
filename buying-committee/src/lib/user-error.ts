/**
 * Raised for expected conditions (bad input, over budget). Its message is safe to show as is.
 * Kept free of SDK imports so browser code (e.g. domain validation) can use it.
 */
export class UserFacingError extends Error {
  override name = 'UserFacingError';
}
