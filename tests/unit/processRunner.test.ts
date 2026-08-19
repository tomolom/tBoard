import { describe, expect, it } from 'vitest';

import { runProcess } from '../../src/main/services/processRunner';

const NODE = process.execPath;

describe('runProcess', () => {
  it('captures stdout and reports a zero exit code on success', async () => {
    const result = await runProcess({
      command: NODE,
      args: ['-e', "process.stdout.write('hello world')"],
      cwd: process.cwd(),
    });

    expect(result.spawnError).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('captures stderr and a non-zero exit code without throwing', async () => {
    const result = await runProcess({
      command: NODE,
      args: ['-e', "process.stderr.write('boom'); process.exit(3);"],
      cwd: process.cwd(),
    });

    expect(result.spawnError).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('reports spawnError (not a throw) for a non-existent executable', async () => {
    const result = await runProcess({
      command: 'tboard-definitely-not-a-real-binary-xyz',
      args: [],
      cwd: process.cwd(),
    });

    expect(result.spawnError).toBe(true);
    expect(result.spawnErrorMessage).toBeTruthy();
    expect(result.exitCode).toBeNull();
  });

  it('kills a process that exceeds its timeout and flags timedOut', async () => {
    const result = await runProcess({
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: process.cwd(),
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('truncates captured output at maxBufferBytes and flags truncated', async () => {
    const result = await runProcess({
      command: NODE,
      args: ['-e', "process.stdout.write('x'.repeat(10000))"],
      cwd: process.cwd(),
      maxBufferBytes: 1000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
  });

  it('does not interpret arguments through a shell (no injection)', async () => {
    // If this were shell-interpreted, the `&&` would chain a second command.
    const result = await runProcess({
      command: NODE,
      args: ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', '&& echo pwned'],
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(0);
    // The `&& echo pwned` is passed as a literal argv entry, not executed.
    expect(result.stdout).toContain('&& echo pwned');
    expect(result.stdout).not.toContain('pwned\n');
  });
});
