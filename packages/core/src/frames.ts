import fs from "node:fs/promises";
import path from "node:path";
import { AvvError } from "./errors.js";
import { run } from "./exec.js";
import { resolveFfmpeg } from "./binaries.js";
import { resolveSource } from "./source.js";
import { probe, type VideoInfo } from "./probe.js";
import { download } from "./download.js";
import { cachePaths, type AvvConfig } from "./config.js";
import {
  ensureDir, resolveAllowed, sanitizeFilename, fileSize,
  formatTimestamp, assertDiskSpace,
} from "./paths.js";

export type FrameMode = "uniform" | "scene" | "keyframe";
export type ImageFormat = "jpg" | "png" | "webp";

export interface FrameOptions {
  source: string;
  /** How many frames to sample. Ignored when `timestamps` is given. */
  count?: number;
  /** Sample exactly these times (seconds) instead of spreading evenly. */
  timestamps?: number[];
  mode?: FrameMode;
  /** Longest edge of each frame, in pixels. 1024 keeps a frame under ~800 vision tokens. */
  maxWidth?: number;
  format?: ImageFormat;
  /** JPEG/WebP quality, 1-100. */
  quality?: number;
  /** Draw the timestamp onto each frame so a grid stays readable. */
  label?: boolean;
  /** Also build a single tiled contact sheet of every frame. */
  contactSheet?: boolean;
  /** Where to write. Defaults to a scratch dir under AVV_HOME. */
  dir?: string;
  timeoutSec?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface Frame {
  index: number;
  timeSec: number;
  timestamp: string;
  path: string;
  bytes: number;
}

export interface FramesResult {
  frames: Frame[];
  info: VideoInfo;
  dir: string;
  contactSheetPath?: string;
  /** Set when the source was a URL we had to fetch. */
  localVideoPath: string;
  downloadedFrom?: string;
  /**
   * Whether timestamps were burned into the frames. False when the local
   * ffmpeg lacks the drawtext filter; the timestamps are still returned per
   * frame, they just are not drawn on the image.
   */
  labelled: boolean;
}

const MIME: Record<ImageFormat, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export function mimeFor(format: ImageFormat): string {
  return MIME[format];
}

/** macOS ships these; the first that exists is used for timestamp burn-in. */
const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

let cachedFont: string | null | undefined;
let cachedDrawtext: boolean | undefined;

/**
 * Does this ffmpeg have the drawtext filter?
 *
 * It requires libfreetype at build time, and plenty of distributed builds omit
 * it - Homebrew's current bottle among them. Asking up front lets timestamp
 * burn-in degrade to plain unlabelled frames instead of failing every extract
 * with "No such filter: 'drawtext'".
 */
async function supportsDrawtext(ffmpeg: string): Promise<boolean> {
  if (cachedDrawtext !== undefined) return cachedDrawtext;
  try {
    const r = await run(ffmpeg, ["-hide_banner", "-filters"], { timeoutMs: 15_000, throwOnNonZero: false });
    cachedDrawtext = /^\s*\S+\s+drawtext\s/m.test(r.stdout);
  } catch {
    cachedDrawtext = false;
  }
  return cachedDrawtext;
}

async function findFont(): Promise<string | null> {
  if (cachedFont !== undefined) return cachedFont;
  for (const f of FONT_CANDIDATES) {
    try {
      await fs.access(f);
      cachedFont = f;
      return f;
    } catch {
      /* try next */
    }
  }
  cachedFont = null;
  return null;
}

/** Escape a string for use inside an ffmpeg filtergraph argument. */
function escapeFilterText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * Spread `count` samples across a duration, offset to the middle of each slice.
 *
 * Sampling at the midpoints rather than the boundaries avoids the black frames
 * and title cards that cluster at the very start and end of most videos.
 */
export function uniformTimestamps(durationSec: number, count: number): number[] {
  const n = Math.max(1, count);
  if (n === 1) return [durationSec / 2];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(((i + 0.5) * durationSec) / n);
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Extract still frames from a video.
 *
 * This is what turns "here is a link" into something a vision model can
 * actually reason about. The frames are written to disk and also handed back
 * with their timestamps so the caller can pair each image with a moment.
 */
export async function extractFrames(opts: FrameOptions, cfg: AvvConfig): Promise<FramesResult> {
  const {
    mode = "uniform",
    maxWidth = 1024,
    format = "jpg",
    quality = 80,
    label = true,
    contactSheet = false,
    signal,
    onProgress,
  } = opts;

  const ffmpeg = await resolveFfmpeg("ffmpeg");
  const src = await resolveSource(opts.source, cfg);

  let localVideoPath: string;
  let info: VideoInfo;
  let downloadedFrom: string | undefined;

  if (src.kind === "url") {
    // 720p is plenty: frames get downscaled to maxWidth anyway, and pulling 4K
    // to make 1024px stills wastes bandwidth and disk.
    const dl = await download(
      {
        source: src.url,
        quality: "720p",
        format: "mp4",
        ...(signal ? { signal } : {}),
        ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
      },
      cfg,
    );
    localVideoPath = dl.path;
    info = dl.info;
    downloadedFrom = src.url;
  } else {
    localVideoPath = src.path;
    info = await probe(src, cfg, signal);
  }

  if (!info.hasVideo) {
    throw new AvvError(
      "NO_VIDEO_STREAM",
      `"${info.title}" has no video track, so there are no frames to extract.`,
      "Use `transcribe` to get the spoken content instead.",
      { title: info.title },
    );
  }

  const duration = info.durationSec;
  if (!duration || duration <= 0) {
    throw new AvvError(
      "PROBE_FAILED",
      `Could not determine the duration of "${info.title}", which is needed to sample frames.`,
      "Pass explicit `timestamps` instead of a frame count.",
      { title: info.title },
    );
  }

  const requested = opts.timestamps?.length ?? opts.count ?? 12;
  const capped = Math.min(requested, cfg.maxFrames);

  const dir = await ensureDir(
    await resolveAllowed(
      opts.dir ?? path.join(cachePaths(cfg).tmp, sanitizeFilename(info.title, 60) + "-frames"),
      cfg,
    ),
  );
  await assertDiskSpace(dir, cfg, capped * 400 * 1024);

  const times =
    opts.timestamps?.length
      ? opts.timestamps.slice(0, cfg.maxFrames).filter((t) => t >= 0 && t <= duration)
      : mode === "uniform"
        ? uniformTimestamps(duration, capped)
        : [];

  // Labels need both a usable font file and an ffmpeg that can draw text.
  const font = label && (await supportsDrawtext(ffmpeg)) ? await findFont() : null;
  const labelled = font !== null;
  const timeoutMs = (opts.timeoutSec ?? cfg.timeoutSec) * 1000;

  const frames: Frame[] =
    times.length > 0
      ? await extractAtTimes({ ffmpeg, localVideoPath, times, dir, format, quality, maxWidth, font, timeoutMs, signal, onProgress })
      : await extractByFilter({ ffmpeg, localVideoPath, mode, dir, format, quality, maxWidth, count: capped, duration, timeoutMs, signal });

  if (!frames.length) {
    throw new AvvError(
      "SUBPROCESS_FAILED",
      "ffmpeg produced no frames.",
      mode === "scene"
        ? "The video may have no detectable scene changes; try `mode: \"uniform\"`."
        : "Check that the video file is not corrupt.",
      { mode },
    );
  }

  let contactSheetPath: string | undefined;
  if (contactSheet && frames.length > 1) {
    contactSheetPath = await buildContactSheet(ffmpeg, frames, dir, format, quality, timeoutMs, signal);
  }

  return {
    frames,
    info,
    dir,
    ...(contactSheetPath ? { contactSheetPath } : {}),
    localVideoPath,
    ...(downloadedFrom ? { downloadedFrom } : {}),
    labelled,
  };
}

interface AtTimesArgs {
  ffmpeg: string;
  localVideoPath: string;
  times: number[];
  dir: string;
  format: ImageFormat;
  quality: number;
  maxWidth: number;
  font: string | null;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

/** One fast-seek ffmpeg invocation per timestamp, a few at a time. */
async function extractAtTimes(a: AtTimesArgs): Promise<Frame[]> {
  let done = 0;
  const failures: unknown[] = [];
  const results = await mapLimit(a.times, 4, async (t, i) => {
    const name = `frame-${String(i + 1).padStart(3, "0")}.${a.format}`;
    const outPath = path.join(a.dir, name);

    const filters = [`scale='min(${a.maxWidth},iw)':-2:flags=lanczos`];
    if (a.font) {
      const text = escapeFilterText(formatTimestamp(t));
      filters.push(
        `drawtext=fontfile='${a.font}':text='${text}':x=12:y=12:fontsize=28:` +
          `fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8`,
      );
    }

    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      // Fast seek before -i; ffmpeg jumps to the nearest keyframe instantly
      // instead of decoding the whole file up to that point.
      "-ss", t.toFixed(3),
      "-i", a.localVideoPath,
      "-frames:v", "1",
      "-vf", filters.join(","),
      ...qualityArgs(a.format, a.quality),
      outPath,
    ];

    try {
      await run(a.ffmpeg, args, { timeoutMs: a.timeoutMs, ...(a.signal ? { signal: a.signal } : {}) });
    } catch (e) {
      // A single unreadable frame (say, a seek past the last keyframe) should
      // not sink the whole request. The error is kept so that a run where
      // every frame failed can report the cause rather than just "no frames".
      failures.push(e);
      return null;
    }

    let bytes: number;
    try {
      bytes = await fileSize(outPath);
    } catch {
      return null;
    }

    done++;
    a.onProgress?.(done, a.times.length);

    return { index: i + 1, timeSec: t, timestamp: formatTimestamp(t), path: outPath, bytes } satisfies Frame;
  });

  const frames = results.filter((f): f is Frame => f !== null);
  if (!frames.length && failures.length) throw failures[0];
  return frames;
}

interface ByFilterArgs {
  ffmpeg: string;
  localVideoPath: string;
  mode: FrameMode;
  dir: string;
  format: ImageFormat;
  quality: number;
  maxWidth: number;
  count: number;
  duration: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/**
 * Scene-change and keyframe modes, in a single decode pass.
 *
 * `showinfo` prints each emitted frame's presentation timestamp to stderr,
 * which is the only way to learn *when* a scene-change frame came from.
 */
async function extractByFilter(a: ByFilterArgs): Promise<Frame[]> {
  const pattern = path.join(a.dir, `frame-%03d.${a.format}`);
  const scale = `scale='min(${a.maxWidth},iw)':-2:flags=lanczos`;

  const args = ["-hide_banner", "-loglevel", "info", "-nostdin", "-y"];
  if (a.mode === "keyframe") args.push("-skip_frame", "nokey");
  args.push("-i", a.localVideoPath);

  const select = a.mode === "scene" ? `select='gt(scene,0.25)',` : "";
  args.push("-vf", `${select}${scale},showinfo`, "-vsync", "vfr", "-frames:v", String(a.count));
  args.push(...qualityArgs(a.format, a.quality), pattern);

  const times: number[] = [];
  await run(a.ffmpeg, args, {
    timeoutMs: a.timeoutMs,
    ...(a.signal ? { signal: a.signal } : {}),
    onStderr: (line) => {
      const m = line.match(/pts_time:([\d.]+)/);
      if (m?.[1]) times.push(Number.parseFloat(m[1]));
    },
  });

  const written = (await fs.readdir(a.dir))
    .filter((f) => f.startsWith("frame-") && f.endsWith(`.${a.format}`))
    .sort();

  return await Promise.all(
    written.map(async (name, i) => {
      const p = path.join(a.dir, name);
      const t = times[i] ?? (a.duration * (i + 0.5)) / Math.max(1, written.length);
      return {
        index: i + 1,
        timeSec: t,
        timestamp: formatTimestamp(t),
        path: p,
        bytes: await fileSize(p),
      } satisfies Frame;
    }),
  );
}

function qualityArgs(format: ImageFormat, quality: number): string[] {
  const q = Math.min(100, Math.max(1, quality));
  if (format === "jpg") {
    // ffmpeg's mjpeg -q:v runs 2 (best) to 31 (worst); map from 1-100.
    return ["-q:v", String(Math.max(2, Math.round(31 - (q / 100) * 29)))];
  }
  if (format === "webp") return ["-quality", String(q)];
  return ["-compression_level", "6"];
}

/** Tile every frame into one image, so a long video fits in a single glance. */
async function buildContactSheet(
  ffmpeg: string,
  frames: Frame[],
  dir: string,
  format: ImageFormat,
  quality: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const cols = Math.ceil(Math.sqrt(frames.length));
  const rows = Math.ceil(frames.length / cols);
  const out = path.join(dir, `contact-sheet.${format}`);

  // The tile filter needs a contiguous numbered sequence; frames are already
  // written as frame-001, frame-002, ...
  const pattern = path.join(dir, `frame-%03d.${format}`);
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", pattern,
    "-vf", `scale=480:-2,tile=${cols}x${rows}:margin=8:padding=6:color=black`,
    "-frames:v", "1",
    ...qualityArgs(format, quality),
    out,
  ];
  await run(ffmpeg, args, { timeoutMs, ...(signal ? { signal } : {}) });
  return out;
}

/** Read a frame back as base64, for embedding in an MCP image content block. */
export async function frameToBase64(frame: Frame): Promise<string> {
  const buf = await fs.readFile(frame.path);
  return buf.toString("base64");
}
