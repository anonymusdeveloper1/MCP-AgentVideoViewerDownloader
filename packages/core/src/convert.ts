import path from "node:path";
import fs from "node:fs/promises";
import { AvvError } from "./errors.js";
import { run } from "./exec.js";
import { resolveFfmpeg } from "./binaries.js";
import { resolveSource } from "./source.js";
import { probe, type VideoInfo } from "./probe.js";
import { download } from "./download.js";
import {
  ensureDir, resolveAllowed, uniquePath, fileSize, sanitizeFilename,
  assertDiskSpace, humanBytes, formatTimestamp,
} from "./paths.js";
import type { AvvConfig } from "./config.js";

export type TargetFormat =
  | "mp4" | "mkv" | "webm" | "mov" | "gif"
  | "mp3" | "m4a" | "wav" | "opus" | "flac" | "aac";

export const TARGET_FORMATS: TargetFormat[] = [
  "mp4", "mkv", "webm", "mov", "gif", "mp3", "m4a", "wav", "opus", "flac", "aac",
];

const AUDIO_ONLY = new Set<TargetFormat>(["mp3", "m4a", "wav", "opus", "flac", "aac"]);

export function isAudioFormat(f: TargetFormat): boolean {
  return AUDIO_ONLY.has(f);
}

/** Encoder settings per audio container. `-q:a` is VBR quality; lower is better. */
const AUDIO_ENCODERS: Record<string, string[]> = {
  mp3: ["-c:a", "libmp3lame", "-q:a", "2"],
  m4a: ["-c:a", "aac", "-b:a", "192k"],
  aac: ["-c:a", "aac", "-b:a", "192k"],
  wav: ["-c:a", "pcm_s16le"],
  opus: ["-c:a", "libopus", "-b:a", "128k"],
  flac: ["-c:a", "flac"],
};

export interface ConvertOptions {
  /** URL or local path. URLs are downloaded first. */
  source: string;
  to: TargetFormat;
  dir?: string;
  filename?: string;
  /** Constant Rate Factor for video re-encodes. Lower is better quality, 18-28 is the useful range. */
  crf?: number;
  /** x264/x265 speed preset. */
  preset?: "ultrafast" | "veryfast" | "fast" | "medium" | "slow";
  /** Cap the output height, e.g. 720. Aspect ratio is preserved. */
  maxHeight?: number;
  /** Force an output frame rate. */
  fps?: number;
  /** Trim to this range before converting. */
  section?: { startSec: number; endSec: number };
  /** Downmix to 16 kHz mono - what speech-to-text wants. Audio targets only. */
  forSpeech?: boolean;
  timeoutSec?: number;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

export interface ConvertResult {
  path: string;
  sizeBytes: number;
  format: TargetFormat;
  /** Set when the input was a URL that had to be fetched first. */
  downloadedFrom?: string;
  /** True when the container was swapped without re-encoding. */
  remuxed: boolean;
  info: VideoInfo;
}

/**
 * Parse ffmpeg's `-progress` stream into a percentage.
 *
 * ffmpeg emits `out_time_us=NNN` lines; dividing by the known duration is the
 * only reliable way to get a percentage out of it.
 */
function progressParser(durationSec: number | null, onProgress: (p: number) => void) {
  return (line: string) => {
    const m = line.match(/^out_time_us=(\d+)/);
    if (!m?.[1] || !durationSec || durationSec <= 0) return;
    const sec = Number.parseInt(m[1], 10) / 1_000_000;
    onProgress(Math.min(100, Math.round((sec / durationSec) * 1000) / 10));
  };
}

/** True when the source streams can be dropped into the target container untouched. */
function canRemux(info: VideoInfo, to: TargetFormat): boolean {
  if (AUDIO_ONLY.has(to) || to === "gif") return false;
  const v = info.videoCodec ?? "";
  const a = info.audioCodec ?? "";
  if (to === "mp4" || to === "mov") return ["h264", "hevc", "av1"].includes(v) && ["aac", "mp3", "ac3"].includes(a);
  if (to === "mkv") return true; // Matroska accepts essentially anything.
  if (to === "webm") return ["vp8", "vp9", "av1"].includes(v) && ["opus", "vorbis"].includes(a);
  return false;
}

/**
 * Convert a video or audio file to another format.
 *
 * When the source is a URL it is downloaded first, so an agent can go straight
 * from a link to an mp3 in one call.
 */
export async function convert(opts: ConvertOptions, cfg: AvvConfig): Promise<ConvertResult> {
  const { to, crf = 23, preset = "medium", maxHeight, fps, section, forSpeech = false, signal, onProgress } = opts;

  if (!TARGET_FORMATS.includes(to)) {
    throw new AvvError(
      "BAD_ARGUMENT",
      `Unsupported target format "${to}".`,
      `Choose one of: ${TARGET_FORMATS.join(", ")}.`,
      { requested: to },
    );
  }

  const ffmpeg = await resolveFfmpeg("ffmpeg");
  const src = await resolveSource(opts.source, cfg);

  // A URL has to become a local file before ffmpeg can touch it. Fetch audio
  // only when the target is audio: no point pulling 4K video to make an mp3.
  let inputPath: string;
  let info: VideoInfo;
  let downloadedFrom: string | undefined;

  if (src.kind === "url") {
    const dl = await download(
      {
        source: src.url,
        quality: AUDIO_ONLY.has(to) ? "audio" : "best",
        ...(AUDIO_ONLY.has(to) ? { format: "m4a" as const } : {}),
        ...(signal ? { signal } : {}),
        ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
      },
      cfg,
    );
    inputPath = dl.path;
    info = dl.info;
    downloadedFrom = src.url;
  } else {
    inputPath = src.path;
    info = await probe(src, cfg, signal);
  }

  if (AUDIO_ONLY.has(to) && !info.hasAudio) {
    throw new AvvError(
      "NO_AUDIO_STREAM",
      `"${info.title}" has no audio track, so it cannot be converted to ${to}.`,
      "Pick a video target format, or use a source that has audio.",
      { title: info.title },
    );
  }
  if (!AUDIO_ONLY.has(to) && !info.hasVideo) {
    throw new AvvError(
      "NO_VIDEO_STREAM",
      `"${info.title}" has no video track, so it cannot be converted to ${to}.`,
      `Convert it to an audio format instead (${[...AUDIO_ONLY].join(", ")}).`,
      { title: info.title },
    );
  }

  const dir = await ensureDir(await resolveAllowed(opts.dir ?? cfg.downloadDir, cfg));
  await assertDiskSpace(dir, cfg, (info.filesizeBytes ?? 0) * 1.5);

  const stem = sanitizeFilename(opts.filename ?? info.title ?? path.basename(inputPath, path.extname(inputPath)));
  const outPath = await uniquePath(path.join(dir, `${stem}.${to}`));

  const remux = canRemux(info, to) && !maxHeight && !fps && !forSpeech;

  const args: string[] = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];

  // -ss before -i seeks by keyframe index and is far faster on long inputs.
  if (section) {
    if (section.endSec <= section.startSec) {
      throw new AvvError("BAD_ARGUMENT", "Section end must be after its start.", "Pass startSec < endSec.", { section });
    }
    args.push("-ss", String(section.startSec));
  }
  args.push("-i", inputPath);
  if (section) args.push("-t", String(section.endSec - section.startSec));

  args.push("-progress", "pipe:1", "-nostats");

  if (AUDIO_ONLY.has(to)) {
    args.push("-vn");
    if (forSpeech) {
      // 16 kHz mono PCM is what whisper.cpp consumes natively.
      args.push("-ar", "16000", "-ac", "1");
    }
    args.push(...(AUDIO_ENCODERS[to] ?? ["-c:a", "aac"]));
  } else if (to === "gif") {
    // Two-pass palette gives dramatically better colour than a naive gif encode.
    const scale = maxHeight ? `scale=-2:${maxHeight}:flags=lanczos` : "scale=-2:480:flags=lanczos";
    args.push("-vf", `fps=${fps ?? 12},${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`);
    args.push("-loop", "0");
  } else if (remux) {
    args.push("-c", "copy", "-movflags", "+faststart");
  } else {
    const filters: string[] = [];
    if (maxHeight) filters.push(`scale=-2:min(${maxHeight}\\,ih)`);
    if (fps) filters.push(`fps=${fps}`);
    if (filters.length) args.push("-vf", filters.join(","));

    if (to === "webm") {
      args.push("-c:v", "libvpx-vp9", "-crf", String(crf), "-b:v", "0", "-c:a", "libopus", "-b:a", "128k");
    } else {
      args.push("-c:v", "libx264", "-crf", String(crf), "-preset", preset, "-pix_fmt", "yuv420p");
      args.push(...(info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]));
      if (to === "mp4" || to === "mov") args.push("-movflags", "+faststart");
    }
  }

  args.push(outPath);

  const durationForProgress = section ? section.endSec - section.startSec : info.durationSec;

  await run(ffmpeg, args, {
    timeoutMs: (opts.timeoutSec ?? cfg.timeoutSec) * 1000,
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onStdout: progressParser(durationForProgress, onProgress) } : {}),
  });

  return {
    path: outPath,
    sizeBytes: await fileSize(outPath),
    format: to,
    ...(downloadedFrom ? { downloadedFrom } : {}),
    remuxed: remux,
    info,
  };
}

/**
 * Cut a segment out of a video, keeping the original format.
 *
 * Re-encodes rather than stream-copying so the cut lands exactly on the
 * requested timestamps; a keyframe-aligned copy can be seconds off.
 */
export async function clip(
  opts: {
    source: string;
    startSec: number;
    endSec: number;
    dir?: string;
    filename?: string;
    reencode?: boolean;
    timeoutSec?: number;
    signal?: AbortSignal;
  },
  cfg: AvvConfig,
): Promise<ConvertResult> {
  const { startSec, endSec, reencode = true } = opts;
  if (endSec <= startSec) {
    throw new AvvError("BAD_ARGUMENT", "Clip end must be after its start.", "Pass startSec < endSec.", { startSec, endSec });
  }

  const ffmpeg = await resolveFfmpeg("ffmpeg");
  const src = await resolveSource(opts.source, cfg);

  let inputPath: string;
  let info: VideoInfo;
  let downloadedFrom: string | undefined;

  if (src.kind === "url") {
    // Ask yt-dlp for just this section so we never pull the whole video.
    const dl = await download(
      {
        source: src.url,
        quality: "best",
        section: { startSec, endSec },
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
      },
      cfg,
    );
    return {
      path: dl.path,
      sizeBytes: dl.sizeBytes,
      format: (path.extname(dl.path).slice(1) as TargetFormat) || "mp4",
      downloadedFrom: src.url,
      remuxed: false,
      info: dl.info,
    };
  }

  inputPath = src.path;
  info = await probe(src, cfg, opts.signal);
  downloadedFrom = undefined;

  if (info.durationSec !== null && startSec >= info.durationSec) {
    throw new AvvError(
      "BAD_ARGUMENT",
      `Clip starts at ${formatTimestamp(startSec)} but the video is only ${formatTimestamp(info.durationSec)} long.`,
      "Pick a start time inside the video.",
      { startSec, durationSec: info.durationSec },
    );
  }

  const dir = await ensureDir(await resolveAllowed(opts.dir ?? cfg.downloadDir, cfg));
  const ext = path.extname(inputPath).slice(1) || "mp4";
  const stem = sanitizeFilename(opts.filename ?? `${info.title} [${Math.round(startSec)}s-${Math.round(endSec)}s]`);
  const outPath = await uniquePath(path.join(dir, `${stem}.${ext}`));

  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", String(startSec), "-i", inputPath, "-t", String(endSec - startSec)];
  if (reencode) {
    args.push("-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p");
    args.push(...(info.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]));
  } else {
    args.push("-c", "copy");
  }
  args.push(outPath);

  await run(ffmpeg, args, {
    timeoutMs: (opts.timeoutSec ?? cfg.timeoutSec) * 1000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return {
    path: outPath,
    sizeBytes: await fileSize(outPath),
    format: ext as TargetFormat,
    ...(downloadedFrom ? { downloadedFrom } : {}),
    remuxed: !reencode,
    info,
  };
}

/** Produce a 16 kHz mono WAV in a scratch directory, ready for whisper.cpp. */
export async function toSpeechWav(
  inputPath: string,
  outPath: string,
  cfg: AvvConfig,
  signal?: AbortSignal,
): Promise<string> {
  const ffmpeg = await resolveFfmpeg("ffmpeg");
  await ensureDir(path.dirname(outPath));
  await run(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", inputPath, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outPath],
    { timeoutMs: cfg.timeoutSec * 1000, ...(signal ? { signal } : {}) },
  );
  return outPath;
}

export function summarizeConvert(res: ConvertResult): string {
  const lines = [
    `Converted to ${res.format}${res.remuxed ? " (remuxed, no quality loss)" : ""}`,
    `Path: ${res.path}`,
    `Size: ${humanBytes(res.sizeBytes)}`,
  ];
  if (res.downloadedFrom) lines.push(`Source: ${res.downloadedFrom}`);
  return lines.join("\n");
}

/** Remove a scratch file, ignoring failures. */
export async function cleanup(p: string): Promise<void> {
  await fs.rm(p, { force: true }).catch(() => {});
}
