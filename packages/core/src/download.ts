import fs from "node:fs/promises";
import path from "node:path";
import { AvvError } from "./errors.js";
import { run } from "./exec.js";
import { resolveYtDlp } from "./binaries.js";
import { resolveSource, type Source } from "./source.js";
import { probe, assertDuration, assertFilesize, type VideoInfo } from "./probe.js";
import { ensureDir, exists, fileSize, resolveAllowed, assertDiskSpace, sanitizeFilename, humanBytes } from "./paths.js";
import type { AvvConfig } from "./config.js";

/** Named quality tiers. Agents pick these far more reliably than raw format strings. */
export type Quality = "best" | "2160p" | "1440p" | "1080p" | "720p" | "480p" | "360p" | "audio";

export const QUALITIES: Quality[] = ["best", "2160p", "1440p", "1080p", "720p", "480p", "360p", "audio"];

export type AudioFormat = "mp3" | "m4a" | "wav" | "opus" | "flac" | "aac";
export type VideoContainer = "mp4" | "mkv" | "webm";

export interface DownloadOptions {
  /** URL or local path. */
  source: string;
  /** Destination directory. Defaults to config.downloadDir. Must be inside an allowed root. */
  dir?: string;
  quality?: Quality;
  /** Container for video downloads, or codec for `quality: "audio"`. */
  format?: VideoContainer | AudioFormat;
  /** Override the output filename (without extension). */
  filename?: string;
  /** Also write subtitle files next to the video. */
  subtitles?: boolean;
  /** Subtitle languages; defaults to the video's original language plus English. */
  subtitleLangs?: string[];
  /** Download a whole playlist rather than just the referenced video. */
  playlist?: boolean;
  /** Only fetch this time range, e.g. `{ startSec: 60, endSec: 180 }`. */
  section?: { startSec: number; endSec: number };
  timeoutSec?: number;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
}

export interface DownloadProgress {
  percent: number;
  totalBytes: number | null;
  speed: string | null;
  eta: string | null;
  stage: "downloading" | "merging" | "extracting-audio" | "post-processing";
}

export interface DownloadResult {
  path: string;
  sizeBytes: number;
  info: VideoInfo;
  subtitlePaths: string[];
  /** Every file written, including thumbnails and subtitles. */
  allFiles: string[];
}

const AUDIO_FORMATS = new Set<string>(["mp3", "m4a", "wav", "opus", "flac", "aac"]);

/** Build a yt-dlp `-f` selector for a quality tier. */
function formatSelector(quality: Quality, container?: VideoContainer): string {
  if (quality === "audio") return "bestaudio/best";

  const heightCap = quality === "best" ? null : Number.parseInt(quality, 10);
  const h = heightCap ? `[height<=${heightCap}]` : "";

  // Prefer an mp4/m4a pair when mp4 is requested so the merge is a remux
  // rather than a re-encode, then fall back progressively.
  if (container === "mp4") {
    return `bv*${h}[ext=mp4]+ba[ext=m4a]/bv*${h}+ba/b${h}/b`;
  }
  return `bv*${h}+ba/b${h}/b`;
}

const PROGRESS_RE = /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+\s*[KMGT]?i?B)?(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/i;

function parseSize(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/([\d.]+)\s*([KMGT]?)i?B/i);
  if (!m?.[1]) return null;
  const mult = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[(m[2] ?? "").toUpperCase()] ?? 1;
  return Math.round(Number.parseFloat(m[1]) * mult);
}

/**
 * Download a video (or its audio) to disk.
 *
 * Local files are returned as-is rather than copied: an agent that already has
 * the file does not need a second copy, and silently duplicating gigabytes is
 * the kind of surprise that fills a disk.
 */
export async function download(opts: DownloadOptions, cfg: AvvConfig): Promise<DownloadResult> {
  const src = await resolveSource(opts.source, cfg);

  if (src.kind === "file") {
    const info = await probe(src, cfg, opts.signal);
    return {
      path: src.path,
      sizeBytes: await fileSize(src.path),
      info,
      subtitlePaths: [],
      allFiles: [src.path],
    };
  }

  return await downloadUrl(src, opts, cfg);
}

async function downloadUrl(src: Extract<Source, { kind: "url" }>, opts: DownloadOptions, cfg: AvvConfig): Promise<DownloadResult> {
  const {
    quality = "best",
    format,
    subtitles = false,
    subtitleLangs,
    playlist = false,
    section,
    signal,
    onProgress,
  } = opts;

  const ytdlp = await resolveYtDlp(cfg);
  const info = await probe(src, cfg, signal);

  if (info.isPlaylist && !playlist) {
    throw new AvvError(
      "BAD_ARGUMENT",
      `That URL is a playlist with ${info.playlistCount ?? "several"} items, not a single video.`,
      "Pass `playlist: true` to download all of them, or link a single video URL.",
      { playlistCount: info.playlistCount },
    );
  }

  if (!playlist) {
    assertDuration(info, cfg);
    assertFilesize(info, cfg);
  }

  const wantAudio = quality === "audio" || (format !== undefined && AUDIO_FORMATS.has(format));
  if (wantAudio && !info.hasAudio) {
    throw new AvvError(
      "NO_AUDIO_STREAM",
      `"${info.title}" has no audio track to extract.`,
      "Download it as video instead, or pick a source that has audio.",
      { title: info.title },
    );
  }

  const dir = await ensureDir(await resolveAllowed(opts.dir ?? cfg.downloadDir, cfg));
  // Reserve roughly 2.5x the reported size: yt-dlp holds separate video and
  // audio streams on disk before merging them.
  await assertDiskSpace(dir, cfg, info.filesizeBytes ? info.filesizeBytes * 2.5 : 0);

  const stem = opts.filename ? sanitizeFilename(opts.filename) : playlist ? "%(playlist_index)s - %(title)s" : "%(title)s";
  const outputTemplate = path.join(dir, `${stem}.%(ext)s`);

  const args: string[] = [
    "--no-warnings",
    "--newline",
    "--progress",
    "--no-simulate",
    // Print the final path after any post-processing/rename so we know exactly
    // what landed on disk, rather than guessing from the template.
    "--print", "after_move:filepath",
    "--no-overwrites",
    "--no-part",
    "--trim-filenames", "180",
    "-o", outputTemplate,
    "--retries", "3",
    "--fragment-retries", "5",
  ];

  args.push(playlist ? "--yes-playlist" : "--no-playlist");

  if (wantAudio) {
    const audioFormat = (format && AUDIO_FORMATS.has(format) ? format : "mp3") as AudioFormat;
    args.push("-f", formatSelector("audio"), "-x", "--audio-format", audioFormat, "--audio-quality", "0");
  } else {
    const container = (format && !AUDIO_FORMATS.has(format) ? format : "mp4") as VideoContainer;
    args.push("-f", formatSelector(quality, container), "--merge-output-format", container);
  }

  if (subtitles) {
    args.push("--write-subs", "--write-auto-subs", "--convert-subs", "srt");
    args.push("--sub-langs", (subtitleLangs?.length ? subtitleLangs : ["en.*", "orig"]).join(","));
  }

  if (section) {
    if (section.endSec <= section.startSec) {
      throw new AvvError("BAD_ARGUMENT", "Section end must be after its start.", "Pass startSec < endSec.", { section });
    }
    args.push("--download-sections", `*${section.startSec}-${section.endSec}`, "--force-keyframes-at-cuts");
  }

  args.push("--", src.url);

  const before = new Set(await listDir(dir));
  const printed: string[] = [];

  await run(ytdlp, args, {
    timeoutMs: (opts.timeoutSec ?? cfg.timeoutSec) * 1000,
    ...(signal ? { signal } : {}),
    onStdout: (line) => {
      const t = line.trim();
      // `--print after_move:filepath` writes bare paths to stdout.
      if (t.startsWith("/") && !t.startsWith("[")) printed.push(t);
    },
    onStderr: (line) => {
      if (!onProgress) return;
      const m = line.match(PROGRESS_RE);
      if (m?.[1]) {
        onProgress({
          percent: Number.parseFloat(m[1]),
          totalBytes: parseSize(m[2]),
          speed: m[3] ?? null,
          eta: m[4] ?? null,
          stage: "downloading",
        });
      } else if (/\[Merger\]/.test(line)) {
        onProgress({ percent: 100, totalBytes: null, speed: null, eta: null, stage: "merging" });
      } else if (/\[ExtractAudio\]/.test(line)) {
        onProgress({ percent: 100, totalBytes: null, speed: null, eta: null, stage: "extracting-audio" });
      }
    },
  });

  // Prefer the paths yt-dlp reported; fall back to diffing the directory in
  // case a future yt-dlp changes its --print behaviour.
  let mediaPaths = printed.filter((p) => !isSubtitle(p));
  const after = await listDir(dir);
  const created = after.filter((f) => !before.has(f)).map((f) => path.join(dir, f));

  if (!mediaPaths.length) {
    mediaPaths = created.filter((p) => !isSubtitle(p) && isMedia(p));
  }
  if (!mediaPaths.length) {
    throw new AvvError(
      "SUBPROCESS_FAILED",
      "yt-dlp finished but no media file appeared in the output directory.",
      "Re-run with a different `quality`, or check whether the file already existed (downloads never overwrite).",
      { dir },
    );
  }

  const primary = mediaPaths[0] as string;
  if (!(await exists(primary))) {
    throw new AvvError(
      "SUBPROCESS_FAILED",
      `yt-dlp reported ${primary} but it is not on disk.`,
      "Retry the download; if it repeats, run `avv doctor`.",
      { path: primary },
    );
  }

  const subtitlePaths = [...new Set([...printed, ...created])].filter(isSubtitle);

  return {
    path: primary,
    sizeBytes: await fileSize(primary),
    info,
    subtitlePaths,
    allFiles: [...new Set([...mediaPaths, ...subtitlePaths, ...created])],
  };
}

function isSubtitle(p: string): boolean {
  return /\.(srt|vtt|ass|ssa|lrc)$/i.test(p);
}

function isMedia(p: string): boolean {
  return /\.(mp4|mkv|webm|mov|avi|flv|m4a|mp3|wav|opus|flac|aac|ogg)$/i.test(p);
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/** Compact, agent-readable summary of what landed on disk. */
export function summarizeDownload(res: DownloadResult): string {
  const lines = [
    `Downloaded: ${res.info.title}`,
    `Path:       ${res.path}`,
    `Size:       ${humanBytes(res.sizeBytes)}`,
  ];
  if (res.subtitlePaths.length) {
    lines.push(`Subtitles:  ${res.subtitlePaths.map((p) => path.basename(p)).join(", ")}`);
  }
  return lines.join("\n");
}
