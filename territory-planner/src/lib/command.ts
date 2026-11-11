/** Quotes one argument for a POSIX shell, leaving plain words as they are. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command that resumes a run after a paid sample stopped partway: the same flags, so the plan
 * and every sample request come out identical and finished territories are read from the saved
 * results. `--refresh` is dropped because re-counting could shift the plan and change the requests.
 */
export function resumeCommand(argv: readonly string[]): string {
  const args = argv.filter((arg) => arg !== '--refresh');
  return ['npm', 'start', '--', ...args].map(shellQuote).join(' ');
}
