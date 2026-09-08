import { spawn } from "node:child_process";
import { AvvError } from "./errors.js";

export interface RunOptions {
  /** Working directory for the child. */
  cwd?: string;
  /** Hard wall-clock limit. The whole process group is killed on expiry. */
  timeoutMs?: number;
  /** Caller-supplied cancellation. */
  signal?: AbortSignal;
  /** Called for each complete line the child writes to stderr (progress). */
  onStderr?: (line: string) => void;
  /** Called for each complete line the child writes to stdout (progress). */
  onStdout?: (line: string) => void;
  /** Extra environment entries merged over process.env. */
  env?: Record<string, string>;
  /** Cap on retained output per stream. Excess is dropped from the middle. */
  maxOutputBytes?: number;
  /** When false, a non-zero exit resolves instead of throwing. */
  throwOnNonZero?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the run was ended by `timeoutMs` rather than exiting on its own. */
  timedOut: boolean;
}

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * Run a binary with an argv array.
 *
 * Never uses a shell: every argument is passed through verbatim, so a URL or a
 * filename containing `;`, backticks, or spaces cannot become executable code.
 * This is the only place in the codebase that spawns a process.
 */
export async function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const {
    cwd,
    timeoutMs,
    signal,
    onStderr,
    onStdout,
    env,
    maxOutputBytes = DEFAULT_MAX_OUTPUT,
    throwOnNonZero = true,
  } = opts;

  if (signal?.aborted) {
    throw new AvvError("CANCELLED", "Operation was cancelled before it started.", "Re-issue the request.");
  }

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so a timeout can take down grandchildren too
      // (yt-dlp shells out to ffmpeg; killing only yt-dlp would orphan it).
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let stdoutRest = "";
    let stderrRest = "";

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        // Negative pid targets the whole process group.
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    let hardKillTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      killTree("SIGTERM");
      hardKillTimer = setTimeout(() => killTree("SIGKILL"), 3000);
      hardKillTimer.unref();
    };

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, timeoutMs)
      : undefined;

    const onAbort = () => {
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length <= maxOutputBytes) stdout += chunk;
      else stdoutTruncated = true;
      if (onStdout) {
        stdoutRest += chunk;
        const lines = stdoutRest.split(/\r?\n|\r/);
        stdoutRest = lines.pop() ?? "";
        for (const l of lines) if (l.length) onStdout(l);
      }
    });

    child.stderr.on("data", (chunk: string) => {
      if (stderr.length + chunk.length <= maxOutputBytes) stderr += chunk;
      else stderrTruncated = true;
      if (onStderr) {
        stderrRest += chunk;
        const lines = stderrRest.split(/\r?\n|\r/);
        stderrRest = lines.pop() ?? "";
        for (const l of lines) if (l.length) onStderr(l);
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err.code === "ENOENT") {
        reject(
          new AvvError(
            "BINARY_MISSING",
            `Executable not found: ${file}`,
            `Install it, or run \`avv doctor\` to see which tools are missing and how to get them.`,
            { file },
          ),
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (onStdout && stdoutRest.length) onStdout(stdoutRest);
      if (onStderr && stderrRest.length) onStderr(stderrRest);
      if (stdoutTruncated) stdout += "\n…[stdout truncated]";
      if (stderrTruncated) stderr += "\n…[stderr truncated]";

      const exit = code ?? -1;

      if (timedOut) {
        reject(
          new AvvError(
            "TIMEOUT",
            `\`${file}\` exceeded its ${Math.round((timeoutMs ?? 0) / 1000)}s time limit and was terminated.`,
            "Retry with a longer `timeoutSec`, a shorter clip, or a lower quality setting.",
            { file, stderr: tail(stderr, 2000) },
          ),
        );
        return;
      }

      if (signal?.aborted) {
        reject(new AvvError("CANCELLED", "Operation was cancelled.", "Re-issue the request."));
        return;
      }

      if (exit !== 0 && throwOnNonZero) {
        reject(
          new AvvError(
            "SUBPROCESS_FAILED",
            `\`${file}\` exited with code ${exit}.\n${tail(stderr, 1500) || tail(stdout, 800)}`,
            "Read the stderr above — it usually names the exact problem (bad URL, unsupported format, missing stream).",
            { file, code: exit },
          ),
        );
        return;
      }

      resolve({ code: exit, stdout, stderr, timedOut });
    });
  });
}

/** Last `n` characters, prefixed with an ellipsis when clipped. */
export function tail(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : "…" + t.slice(-n);
}

/** True when `file` can be executed. Used for capability probing, never for control flow on user input. */
export async function canRun(file: string, args: string[] = ["--version"], timeoutMs = 10_000): Promise<boolean> {
  try {
    const r = await run(file, args, { timeoutMs, throwOnNonZero: false });
    return r.code === 0;
  } catch {
    return false;
  }
}
