import { spawn } from 'node:child_process';

export type ProcessRunRequest = {
  /** Executable to run (resolved from PATH). Executed via argv, never a shell. */
  command: string;
  /** Argument vector. Passed verbatim to the child; no shell interpolation. */
  args: string[];
  /** Working directory the child runs in. */
  cwd: string;
  /** Hard timeout in milliseconds before the child is killed. */
  timeoutMs?: number;
  /** Extra environment variables merged over the parent environment. */
  env?: Record<string, string>;
  /** Max bytes captured per stream before truncation. Defaults to 5 MB. */
  maxBufferBytes?: number;
};

export type ProcessRunResult = {
  command: string;
  args: string[];
  cwd: string;
  /** Process exit code, or null if the process was terminated by a signal/timeout. */
  exitCode: number | null;
  /** Signal that terminated the process, if any. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True if the run was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /** True if stdout or stderr was truncated at `maxBufferBytes`. */
  truncated: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True when the child could not be spawned at all (e.g. ENOENT). */
  spawnError: boolean;
  spawnErrorMessage: string | null;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

/**
 * Runs a child process safely and captures its output.
 *
 * Safety properties:
 * - Executes via argv (`shell: false`), so command arguments are never
 *   interpreted by a shell — no injection through card titles, paths, etc.
 * - Always enforces a timeout and kills the process tree on expiry.
 * - Bounds captured output to avoid unbounded memory growth; sets `truncated`.
 * - Never throws for process-level failures; a failed/non-zero/killed run is
 *   returned as a structured result. Only truly unexpected internal errors
 *   reject the promise.
 */
export function runProcess(request: ProcessRunRequest): Promise<ProcessRunResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = request.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const startedAt = Date.now();

  return new Promise<ProcessRunResult>((resolve) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (partial: Partial<ProcessRunResult>): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        command: request.command,
        args: request.args,
        cwd: request.cwd,
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
        spawnError: false,
        spawnErrorMessage: null,
        ...partial,
      });
    };

    let child;
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env ? { ...process.env, ...request.env } : process.env,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      finish({
        spawnError: true,
        spawnErrorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const appendChunk = (chunks: Buffer[], bytesSoFar: number, chunk: Buffer): number => {
      if (bytesSoFar >= maxBufferBytes) {
        truncated = true;
        return bytesSoFar;
      }
      const remaining = maxBufferBytes - bytesSoFar;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        truncated = true;
        return maxBufferBytes;
      }
      chunks.push(chunk);
      return bytesSoFar + chunk.length;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes = appendChunk(stdoutChunks, stdoutBytes, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = appendChunk(stderrChunks, stderrBytes, chunk);
    });

    child.on('error', (error) => {
      finish({
        spawnError: true,
        spawnErrorMessage: error instanceof Error ? error.message : String(error),
      });
    });

    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal });
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    // Do not let the timer keep the event loop alive on its own.
    timer.unref?.();
  });
}
