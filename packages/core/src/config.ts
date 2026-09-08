import os from "node:os";
import path from "node:path";

/** Parse an integer env var, falling back when unset or malformed. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envPath(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? expandHome(raw.trim()) : fallback;
}

/** Expand a leading `~` — agents and humans both write paths that way. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface AvvConfig {
  /** Cache root for provisioned binaries, Whisper models, and scratch files. */
  home: string;
  /** Where downloads land when the caller does not name a directory. */
  downloadDir: string;
  /** Writes are confined to these roots. Anything outside is refused. */
  allowedRoots: string[];
  /** Refuse sources longer than this. Stops an agent burning an hour on a livestream. */
  maxDurationSec: number;
  /** Refuse downloads larger than this. */
  maxFilesizeMb: number;
  /** Keep this much disk free; refuse to start a download that would eat into it. */
  minFreeDiskMb: number;
  /** Default per-operation wall-clock limit. */
  timeoutSec: number;
  /** whisper.cpp model name, e.g. tiny | base | small | medium | large-v3-turbo. */
  whisperModel: string;
  /** Max frames a single watch/frames call may emit, regardless of what was asked. */
  maxFrames: number;
}

export function loadConfig(): AvvConfig {
  const home = envPath("AVV_HOME", path.join(os.homedir(), ".avv"));
  const roots = (process.env.AVV_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(expandHome);

  return {
    home,
    downloadDir: envPath("AVV_DOWNLOAD_DIR", path.join(os.homedir(), "Downloads", "avv")),
    // Default: the user's home plus our own cache. Deliberately excludes /etc,
    // /usr, /System — an agent that gets confused (or prompt-injected by a video
    // title) still cannot write outside the user's own space.
    allowedRoots: roots.length ? roots : [os.homedir(), os.tmpdir(), home],
    maxDurationSec: envInt("AVV_MAX_DURATION_SEC", 4 * 60 * 60),
    maxFilesizeMb: envInt("AVV_MAX_FILESIZE_MB", 4096),
    minFreeDiskMb: envInt("AVV_MIN_FREE_DISK_MB", 1024),
    timeoutSec: envInt("AVV_TIMEOUT_SEC", 30 * 60),
    whisperModel: process.env.AVV_WHISPER_MODEL?.trim() || "base",
    maxFrames: envInt("AVV_MAX_FRAMES", 64),
  };
}

/** Subdirectories under the cache root. */
export function cachePaths(cfg: AvvConfig) {
  return {
    bin: path.join(cfg.home, "bin"),
    models: path.join(cfg.home, "models"),
    tmp: path.join(cfg.home, "tmp"),
  };
}
