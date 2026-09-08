/**
 * Errors carry a machine-readable `code` and a `remediation` string.
 *
 * The remediation matters more than usual here: the primary caller is an AI
 * agent, and an agent that is told exactly which command to run can fix its own
 * problem instead of giving up or hallucinating a workaround.
 */
export type AvvErrorCode =
  | "BINARY_MISSING"
  | "MODEL_MISSING"
  | "UNSUPPORTED_SOURCE"
  | "SOURCE_NOT_FOUND"
  | "PATH_NOT_ALLOWED"
  | "DISK_FULL"
  | "TOO_LARGE"
  | "TOO_LONG"
  | "TIMEOUT"
  | "CANCELLED"
  | "SUBPROCESS_FAILED"
  | "PROBE_FAILED"
  | "NO_AUDIO_STREAM"
  | "NO_VIDEO_STREAM"
  | "BAD_ARGUMENT"
  | "NETWORK";

export class AvvError extends Error {
  readonly code: AvvErrorCode;
  readonly remediation: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AvvErrorCode,
    message: string,
    remediation: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AvvError";
    this.code = code;
    this.remediation = remediation;
    this.details = details;
  }

  /** Compact shape suitable for returning to an agent as JSON. */
  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      remediation: this.remediation,
      ...(this.details ? { details: this.details } : {}),
    };
  }

  /** Single-line rendering used by both the CLI and the MCP error path. */
  toDisplay(): string {
    return `[${this.code}] ${this.message}\n\nHow to fix: ${this.remediation}`;
  }
}

export function isAvvError(e: unknown): e is AvvError {
  return e instanceof AvvError;
}

/** Wrap anything thrown into an AvvError so callers see one consistent shape. */
export function toAvvError(e: unknown, fallbackRemediation = "Retry; if it persists, run `avv doctor` to check the toolchain."): AvvError {
  if (isAvvError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new AvvError("SUBPROCESS_FAILED", message, fallbackRemediation);
}
