import { describe, expect, it } from 'vitest';
import { resumeCommand, shellQuote } from '../src/lib/command.js';

describe('resumeCommand', () => {
  it('repeats the original flags so the plan and sample requests come out the same', () => {
    expect(resumeCommand(['--icp', 'examples/icp.json', '--reps', 'Ana,Ben,Chen,Dee', '--sample', '2']))
      .toBe('npm start -- --icp examples/icp.json --reps Ana,Ben,Chen,Dee --sample 2');
  });

  it('drops --refresh, which could re-count and shift the plan', () => {
    expect(resumeCommand(['--icp', 'icp.json', '--refresh', '--sample', '2'])).toBe('npm start -- --icp icp.json --sample 2');
  });

  it('quotes arguments the shell would split or expand', () => {
    expect(shellQuote('Ana Lee,Ben')).toBe("'Ana Lee,Ben'");
    expect(shellQuote("O'Neil")).toBe(`'O'\\''Neil'`);
    expect(shellQuote('$HOME')).toBe("'$HOME'");
  });
});
