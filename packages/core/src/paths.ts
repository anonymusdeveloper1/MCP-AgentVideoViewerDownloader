import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { AvvError } from "./errors.js";
import { expandHome, type AvvConfig } from "./config.js";

/**
 * Resolve a caller-supplied path and prove it lands inside an allowed root.
 *
 * Symlinks are resolved before the check. A path like
 * `~/Downloads/link-to-etc/passwd` therefore fails even though its literal text
 * looks like it is inside the home directory.
 */
export async function resolveAllowed(input: string, cfg: AvvConfig): Promise<string> {
  const abs = path.resolve(expandHome(input));
  const real = await realpathNearest(abs);
  const roots = await Promise.all(cfg.allowedRoots.map((r) => realpathNearest(path.resolve(r))));

  const ok = roots.some((root) => real === root || real.startsWith(root + path.sep));
  if (!ok) {
    throw new AvvError(
      "PATH_NOT_ALLOWED",
      `Refusing to write to ${abs} - it is outside the allowed roots.`,
      `Choose a directory inside one of: ${cfg.allowedRoots.join(", ")}. ` +
        `To widen this, set AVV_ALLOWED_ROOTS (colon-separated) before starting the server.`,
      { requested: abs, allowedRoots: cfg.allowedRoots },
    );
  }
  return abs;
}

/**
 * realpath the deepest ancestor that exists, then re-append the missing tail.
 * Plain realpath() throws on paths that have not been created yet, but we need
 * to validate destinations before creating them.
 */
async function realpathNearest(abs: string): Promise<string> {
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // hit the filesystem root
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Characters that are illegal in filenames on macOS or Windows. */
const ILLEGAL_CHARS = /[/\\?%*:|"<>]/g;

/**
 * Drop C0 control characters and DEL.
 *
 * Done by code point rather than a regex character class so the source file
 * stays free of literal control bytes.
 */
function stripControls(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** Strip characters that break filenames on macOS or Windows, and clamp length. */
export function sanitizeFilename(name: string, maxLen = 120): string {
  const cleaned = stripControls(name.normalize("NFC"))
    .replace(ILLEGAL_CHARS, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  const safe = cleaned.length ? cleaned : "video";
  return safe.length > maxLen ? safe.slice(0, maxLen).trimEnd() : safe;
}

export async function ensureDir(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Append ` (2)`, ` (3)`... until the path is free. Never overwrites silently. */
export async function uniquePath(target: string): Promise<string> {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let candidate = target;
  for (let i = 2; i < 1000; i++) {
    if (!(await exists(candidate))) return candidate;
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(p: string): Promise<number> {
  const st = await fs.stat(p);
  return st.size;
}

/** Free bytes on the filesystem holding `dir` (walks up to an existing ancestor). */
export function freeDiskBytes(dir: string): number | null {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      const st = fsSync.statfsSync(cur);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

/** Refuse to start work that would leave the disk critically full. */
export async function assertDiskSpace(dir: string, cfg: AvvConfig, needBytes = 0): Promise<void> {
  const free = freeDiskBytes(dir);
  if (free === null) return; // cannot tell; do not block
  const floor = cfg.minFreeDiskMb * 1024 * 1024;
  if (free - needBytes < floor) {
    throw new AvvError(
      "DISK_FULL",
      `Only ${mb(free)} MB free on the volume holding ${dir}; this needs about ${mb(needBytes)} MB ` +
        `and must leave ${cfg.minFreeDiskMb} MB headroom.`,
      "Free up disk space, choose a directory on another volume, or lower AVV_MIN_FREE_DISK_MB.",
      { freeBytes: free, needBytes },
    );
  }
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Seconds to `hh:mm:ss` / `mm:ss`. Used in transcripts, chapters, frame labels. */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
