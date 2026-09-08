import path from "node:path";
import { AvvError } from "./errors.js";
import { run } from "./exec.js";
import { resolveFfmpeg, resolveYtDlp } from "./binaries.js";
import { formatTimestamp, humanBytes } from "./paths.js";
import type { AvvConfig } from "./config.js";
import type { Source } from "./source.js";

export interface Chapter {
  title: string;
  startSec: number;
  endSec: number;
}

export interface VideoInfo {
  /** The original URL or absolute file path. */
  source: string;
  kind: "url" | "file";
  title: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  filesizeBytes: number | null;
  uploader: string | null;
  uploadDate: string | null;
  viewCount: number | null;
  description: string | null;
  webpageUrl: string | null;
  chapters: Chapter[];
  /** Subtitle language codes offered by the site (remote sources only). */
  subtitleLangs: string[];
  /** True when the URL points at a playlist rather than a single video. */
  isPlaylist: boolean;
  playlistCount: number | null;
  /** Whether the source is a live stream (duration is unbounded). */
  isLive: boolean;
}

/* ------------------------------------------------------------------ ffprobe */

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface FfprobeChapter {
  start_time?: string;
  end_time?: string;
  tags?: { title?: string };
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  chapters?: FfprobeChapter[];
  format?: {
    duration?: string;
    size?: string;
    tags?: Record<string, string>;
  };
}

/** Parse ffprobe's `num/den` frame-rate notation. */
function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !d) return null;
  const fps = n / d;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

function num(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export async function probeLocalFile(filePath: string): Promise<VideoInfo> {
  const ffprobe = await resolveFfmpeg("ffprobe");
  const r = await run(
    ffprobe,
    [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      "-show_chapters",
      filePath,
    ],
    { timeoutMs: 60_000, throwOnNonZero: false },
  );

  let data: FfprobeOutput;
  try {
    data = JSON.parse(r.stdout) as FfprobeOutput;
  } catch {
    throw new AvvError(
      "PROBE_FAILED",
      `ffprobe could not read ${filePath} as media.`,
      "Confirm the file is a real video/audio file and not corrupt or still downloading.",
      { path: filePath },
    );
  }

  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const tags = data.format?.tags ?? {};

  return {
    source: filePath,
    kind: "file",
    // Basename without the extension: this becomes the stem of any derived
    // file, and "clip.mp4.gif" reads like a mistake.
    title: tags.title ?? (path.basename(filePath, path.extname(filePath)) || "video"),
    durationSec: num(data.format?.duration),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseRate(video?.avg_frame_rate ?? video?.r_frame_rate),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    filesizeBytes: num(data.format?.size),
    uploader: tags.artist ?? null,
    uploadDate: tags.date ?? null,
    viewCount: null,
    description: tags.comment ?? null,
    webpageUrl: null,
    chapters: (data.chapters ?? []).map((c, i) => ({
      title: c.tags?.title ?? `Chapter ${i + 1}`,
      startSec: num(c.start_time) ?? 0,
      endSec: num(c.end_time) ?? 0,
    })),
    subtitleLangs: [],
    isPlaylist: false,
    playlistCount: null,
    isLive: false,
  };
}

/* ------------------------------------------------------------------- yt-dlp */

interface YtdlpJson {
  _type?: string;
  id?: string;
  title?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
  uploader?: string;
  channel?: string;
  upload_date?: string;
  view_count?: number;
  description?: string;
  webpage_url?: string;
  is_live?: boolean;
  live_status?: string;
  playlist_count?: number;
  entries?: unknown[];
  chapters?: { title?: string; start_time?: number; end_time?: number }[];
  subtitles?: Record<string, unknown>;
  automatic_captions?: Record<string, unknown>;
}

/** Format `YYYYMMDD` as `YYYY-MM-DD`; yt-dlp emits the compact form. */
function formatUploadDate(d: string | undefined): string | null {
  if (!d || !/^\d{8}$/.test(d)) return d ?? null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export async function probeUrl(url: string, cfg: AvvConfig, signal?: AbortSignal): Promise<VideoInfo> {
  const ytdlp = await resolveYtDlp(cfg);
  const r = await run(
    ytdlp,
    ["--dump-single-json", "--no-warnings", "--flat-playlist", "--", url],
    { timeoutMs: 120_000, ...(signal ? { signal } : {}) },
  );

  let data: YtdlpJson;
  try {
    data = JSON.parse(r.stdout) as YtdlpJson;
  } catch {
    throw new AvvError(
      "PROBE_FAILED",
      `yt-dlp returned no usable metadata for ${url}.`,
      "Confirm the URL opens in a browser. Age-restricted or members-only videos need cookies (see README).",
      { url },
    );
  }

  const isPlaylist = data._type === "playlist" || Array.isArray(data.entries);
  const subs = Object.keys(data.subtitles ?? {});
  const autoSubs = Object.keys(data.automatic_captions ?? {});

  return {
    source: url,
    kind: "url",
    title: data.title ?? "video",
    durationSec: data.duration ?? null,
    width: data.width ?? null,
    height: data.height ?? null,
    fps: data.fps ?? null,
    hasVideo: data.vcodec !== "none",
    hasAudio: data.acodec !== "none",
    videoCodec: data.vcodec ?? null,
    audioCodec: data.acodec ?? null,
    filesizeBytes: data.filesize ?? data.filesize_approx ?? null,
    uploader: data.uploader ?? data.channel ?? null,
    uploadDate: formatUploadDate(data.upload_date),
    viewCount: data.view_count ?? null,
    description: data.description ?? null,
    webpageUrl: data.webpage_url ?? url,
    chapters: (data.chapters ?? []).map((c, i) => ({
      title: c.title ?? `Chapter ${i + 1}`,
      startSec: c.start_time ?? 0,
      endSec: c.end_time ?? 0,
    })),
    subtitleLangs: [...new Set([...subs, ...autoSubs])].sort(),
    isPlaylist,
    playlistCount: data.playlist_count ?? (Array.isArray(data.entries) ? data.entries.length : null),
    isLive: Boolean(data.is_live) || data.live_status === "is_live",
  };
}

/** Probe either kind of source. */
export async function probe(src: Source, cfg: AvvConfig, signal?: AbortSignal): Promise<VideoInfo> {
  return src.kind === "file" ? await probeLocalFile(src.path) : await probeUrl(src.url, cfg, signal);
}

/* ------------------------------------------------------------------- guards */

/**
 * Refuse absurdly long sources before doing expensive work.
 *
 * An agent handed a 12-hour livestream URL would otherwise happily start a
 * download that never ends and fills the disk.
 */
export function assertDuration(info: VideoInfo, cfg: AvvConfig): void {
  if (info.isLive) {
    throw new AvvError(
      "TOO_LONG",
      `"${info.title}" is a live stream, which has no fixed duration.`,
      "Live streams are not supported. Wait for the VOD, or use `clip` with an explicit start and end.",
      { title: info.title },
    );
  }
  if (info.durationSec !== null && info.durationSec > cfg.maxDurationSec) {
    throw new AvvError(
      "TOO_LONG",
      `"${info.title}" runs ${formatTimestamp(info.durationSec)}, over the ${formatTimestamp(cfg.maxDurationSec)} limit.`,
      "Use `clip` to take the segment you need, or raise AVV_MAX_DURATION_SEC.",
      { durationSec: info.durationSec, limitSec: cfg.maxDurationSec },
    );
  }
}

export function assertFilesize(info: VideoInfo, cfg: AvvConfig): void {
  const limit = cfg.maxFilesizeMb * 1024 * 1024;
  if (info.filesizeBytes !== null && info.filesizeBytes > limit) {
    throw new AvvError(
      "TOO_LARGE",
      `"${info.title}" is ${humanBytes(info.filesizeBytes)}, over the ${cfg.maxFilesizeMb} MB limit.`,
      "Request a lower `quality`, download audio only, or raise AVV_MAX_FILESIZE_MB.",
      { filesizeBytes: info.filesizeBytes, limitMb: cfg.maxFilesizeMb },
    );
  }
}

/** One-screen summary. Deliberately compact: this often goes straight into an agent's context. */
export function summarizeInfo(info: VideoInfo): string {
  const lines: string[] = [];
  lines.push(`Title:    ${info.title}`);
  if (info.uploader) lines.push(`Uploader: ${info.uploader}`);
  if (info.durationSec !== null) lines.push(`Duration: ${formatTimestamp(info.durationSec)}`);
  if (info.width && info.height) {
    lines.push(`Video:    ${info.width}x${info.height}${info.fps ? ` @ ${info.fps}fps` : ""}${info.videoCodec ? ` (${info.videoCodec})` : ""}`);
  }
  if (info.hasAudio) lines.push(`Audio:    ${info.audioCodec ?? "present"}`);
  else lines.push(`Audio:    none`);
  if (info.filesizeBytes) lines.push(`Size:     ${humanBytes(info.filesizeBytes)}`);
  if (info.uploadDate) lines.push(`Uploaded: ${info.uploadDate}`);
  if (info.viewCount !== null) lines.push(`Views:    ${info.viewCount.toLocaleString("en-US")}`);
  if (info.subtitleLangs.length) {
    const shown = info.subtitleLangs.slice(0, 12).join(", ");
    lines.push(`Subtitles: ${shown}${info.subtitleLangs.length > 12 ? `, +${info.subtitleLangs.length - 12} more` : ""}`);
  }
  if (info.isPlaylist) lines.push(`Playlist: ${info.playlistCount ?? "?"} items`);
  if (info.chapters.length) {
    lines.push(`Chapters (${info.chapters.length}):`);
    for (const c of info.chapters.slice(0, 25)) {
      lines.push(`  ${formatTimestamp(c.startSec)}  ${c.title}`);
    }
    if (info.chapters.length > 25) lines.push(`  ... +${info.chapters.length - 25} more`);
  }
  if (info.description) {
    const desc = info.description.trim().split("\n").slice(0, 6).join("\n");
    if (desc) lines.push(`\nDescription:\n${desc}${info.description.length > desc.length ? "\n..." : ""}`);
  }
  return lines.join("\n");
}
