import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import { AvvError } from "./errors.js";
import { run, canRun } from "./exec.js";
import { cachePaths, type AvvConfig } from "./config.js";
import { ensureDir, exists } from "./paths.js";

export type ToolName = "ffmpeg" | "ffprobe" | "yt-dlp" | "whisper";

export interface ToolStatus {
  name: ToolName;
  found: boolean;
  path?: string;
  version?: string;
  /** True when we can install it ourselves without asking the user. */
  autoInstallable: boolean;
  hint?: string;
}

/** whisper.cpp renamed its binary from `main` to `whisper-cli` in 1.7. Accept both. */
const WHISPER_BINARIES = ["whisper-cli", "whisper-cpp", "whisper", "main"];

/** Look up an executable on PATH without invoking a shell. */
async function which(name: string): Promise<string | undefined> {
  try {
    const r = await run("/usr/bin/which", [name], { timeoutMs: 5000, throwOnNonZero: false });
    const first = r.stdout.split("\n").map((s) => s.trim()).find(Boolean);
    return r.code === 0 && first ? first : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ ffmpeg */

/**
 * ffmpeg and ffprobe are hard requirements. We do not vendor them: the binaries
 * are large, licence-encumbered in some builds, and almost always already
 * present. When missing we say exactly how to get them.
 */
export async function resolveFfmpeg(kind: "ffmpeg" | "ffprobe" = "ffmpeg"): Promise<string> {
  const envOverride = process.env[kind === "ffmpeg" ? "AVV_FFMPEG_PATH" : "AVV_FFPROBE_PATH"];
  if (envOverride && (await exists(envOverride))) return envOverride;

  const found = await which(kind);
  if (found) return found;

  throw new AvvError(
    "BINARY_MISSING",
    `${kind} was not found on PATH.`,
    os.platform() === "darwin"
      ? `Install it with: brew install ffmpeg`
      : `Install FFmpeg from your package manager (e.g. apt install ffmpeg) or https://ffmpeg.org/download.html`,
    { tool: kind },
  );
}

/* ------------------------------------------------------------------- yt-dlp */

function ytDlpAssetName(): string | undefined {
  const plat = os.platform();
  const arch = os.arch();
  if (plat === "darwin") return "yt-dlp_macos";
  if (plat === "linux") return arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
  if (plat === "win32") return "yt-dlp.exe";
  return undefined;
}

/**
 * Resolve yt-dlp, downloading the standalone build into our cache if needed.
 *
 * The standalone binaries bundle their own Python, which matters here: the
 * system Python on this class of machine is often far too old for modern
 * yt-dlp, and `pip install` would fail or silently install a broken version.
 */
export async function resolveYtDlp(cfg: AvvConfig, opts: { autoInstall?: boolean } = {}): Promise<string> {
  const { autoInstall = true } = opts;

  const envOverride = process.env.AVV_YTDLP_PATH;
  if (envOverride && (await exists(envOverride))) return envOverride;

  const onPath = await which("yt-dlp");
  if (onPath) return onPath;

  const { bin } = cachePaths(cfg);
  const cached = path.join(bin, os.platform() === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (await exists(cached)) return cached;

  if (!autoInstall) {
    throw new AvvError(
      "BINARY_MISSING",
      "yt-dlp was not found and auto-install is disabled.",
      "Run `avv doctor --install`, or install it yourself with `brew install yt-dlp`.",
      { tool: "yt-dlp" },
    );
  }

  const asset = ytDlpAssetName();
  if (!asset) {
    throw new AvvError(
      "BINARY_MISSING",
      `No prebuilt yt-dlp binary is published for ${os.platform()}/${os.arch()}.`,
      "Install yt-dlp manually and point AVV_YTDLP_PATH at it.",
      { tool: "yt-dlp" },
    );
  }

  await ensureDir(bin);
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  await downloadFile(url, cached, "yt-dlp");
  await fs.chmod(cached, 0o755);

  // Prove it actually runs before handing the path back, so a truncated
  // download fails here rather than deep inside a later command.
  //
  // The generous timeout is deliberate: the standalone build is a PyInstaller
  // bundle that unpacks its embedded Python on first launch, which takes
  // 10-30s on a cold cache. A short timeout here misreports a healthy binary
  // as broken.
  if (!(await canRun(cached, ["--version"], 180_000))) {
    await fs.rm(cached, { force: true });
    throw new AvvError(
      "BINARY_MISSING",
      "Downloaded yt-dlp but it would not execute.",
      `Install it via Homebrew instead: brew install yt-dlp`,
      { tool: "yt-dlp", path: cached },
    );
  }
  return cached;
}

/** True when this path is the standalone bundle we provisioned ourselves. */
export function isStandaloneYtDlp(binPath: string, cfg: AvvConfig): boolean {
  return binPath.startsWith(cachePaths(cfg).bin);
}

/**
 * Install yt-dlp with Homebrew.
 *
 * Strongly preferred over the standalone binary wherever brew exists. The
 * standalone build is a PyInstaller bundle that re-extracts its embedded
 * Python on *every* invocation - measured at ~11s per call against ~0.25s for
 * the Homebrew build. A single `watch` runs yt-dlp two or three times, so that
 * is the difference between half a minute of dead air and none.
 *
 * Only ever called from an explicit `avv doctor --install`. Writing into the
 * user's Homebrew prefix is their decision, so the implicit path in
 * resolveYtDlp still uses the self-contained cache download.
 */
export async function installYtDlpViaBrew(): Promise<string | null> {
  const brew = await which("brew");
  if (!brew) return null;
  await run(brew, ["install", "yt-dlp"], { timeoutMs: 15 * 60_000 });
  return (await which("yt-dlp")) ?? null;
}

/* ------------------------------------------------------------------ whisper */

export async function resolveWhisper(): Promise<string> {
  const envOverride = process.env.AVV_WHISPER_PATH;
  if (envOverride && (await exists(envOverride))) return envOverride;

  for (const name of WHISPER_BINARIES) {
    const found = await which(name);
    if (found) return found;
  }

  throw new AvvError(
    "BINARY_MISSING",
    "whisper.cpp was not found on PATH (looked for whisper-cli, whisper-cpp, whisper, main).",
    os.platform() === "darwin"
      ? "Install it with: brew install whisper-cpp"
      : "Build whisper.cpp from https://github.com/ggml-org/whisper.cpp and put whisper-cli on PATH.",
    { tool: "whisper" },
  );
}

/** Models are ~75 MB (tiny) to ~3 GB (large). Downloaded once, then cached. */
export async function resolveWhisperModel(cfg: AvvConfig, model = cfg.whisperModel): Promise<string> {
  const { models } = cachePaths(cfg);
  const file = path.join(models, `ggml-${model}.bin`);
  if (await exists(file)) return file;

  await ensureDir(models);
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
  await downloadFile(url, file, `whisper model "${model}"`);
  return file;
}

/* ----------------------------------------------------------------- download */

/** Stream a URL to disk, writing to a temp file first so a failure leaves no partial. */
async function downloadFile(url: string, dest: string, label: string): Promise<void> {
  const tmp = `${dest}.partial`;
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    throw new AvvError(
      "NETWORK",
      `Could not reach ${url} to fetch ${label}: ${e instanceof Error ? e.message : String(e)}`,
      "Check your network connection, then retry.",
      { url },
    );
  }
  if (!res.ok || !res.body) {
    throw new AvvError(
      "NETWORK",
      `Download of ${label} failed with HTTP ${res.status}.`,
      `Fetch it manually from ${url} if the problem persists.`,
      { url, status: res.status },
    );
  }
  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw new AvvError(
      "NETWORK",
      `Writing ${label} to disk failed: ${e instanceof Error ? e.message : String(e)}`,
      "Check available disk space and permissions on the cache directory, then retry.",
      { dest },
    );
  }
}

/* ------------------------------------------------------------------- doctor */

async function versionOf(bin: string, args: string[], pick: (out: string) => string): Promise<string | undefined> {
  try {
    const r = await run(bin, args, { timeoutMs: 60_000, throwOnNonZero: false });
    return pick(`${r.stdout}\n${r.stderr}`).trim() || undefined;
  } catch {
    return undefined;
  }
}

const firstLine = (s: string) => s.split("\n")[0] ?? "";

/** Report on every external dependency. Backs both `avv doctor` and the MCP health tool. */
export async function checkTools(cfg: AvvConfig): Promise<ToolStatus[]> {
  const out: ToolStatus[] = [];

  for (const kind of ["ffmpeg", "ffprobe"] as const) {
    const found = await which(kind);
    const version = found ? await versionOf(found, ["-version"], firstLine) : undefined;
    out.push({
      name: kind,
      found: Boolean(found),
      ...(found ? { path: found } : {}),
      ...(version ? { version } : {}),
      autoInstallable: false,
      ...(found ? {} : { hint: "brew install ffmpeg" }),
    });
  }

  const ytdlp = (await which("yt-dlp")) ?? (await cachedYtDlp(cfg));
  const slowStandalone = ytdlp !== undefined && isStandaloneYtDlp(ytdlp, cfg);
  const ytdlpVersion = ytdlp ? await versionOf(ytdlp, ["--version"], firstLine) : undefined;
  out.push({
    name: "yt-dlp",
    found: Boolean(ytdlp),
    ...(ytdlp ? { path: ytdlp } : {}),
    ...(ytdlpVersion ? { version: ytdlpVersion } : {}),
    autoInstallable: true,
    ...(ytdlp
      ? slowStandalone
        ? { hint: "standalone build: ~11s startup per call. `brew install yt-dlp` is ~40x faster." }
        : {}
      : { hint: "auto-installed on first use, or: brew install yt-dlp" }),
  });

  let whisper: string | undefined;
  for (const name of WHISPER_BINARIES) {
    whisper = await which(name);
    if (whisper) break;
  }
  out.push({
    name: "whisper",
    found: Boolean(whisper),
    ...(whisper ? { path: whisper } : {}),
    autoInstallable: false,
    ...(whisper ? {} : { hint: "brew install whisper-cpp" }),
  });

  return out;
}

async function cachedYtDlp(cfg: AvvConfig): Promise<string | undefined> {
  const p = path.join(cachePaths(cfg).bin, os.platform() === "win32" ? "yt-dlp.exe" : "yt-dlp");
  return (await exists(p)) ? p : undefined;
}
