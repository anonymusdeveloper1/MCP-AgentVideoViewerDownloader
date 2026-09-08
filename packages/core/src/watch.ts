import path from "node:path";
import { resolveSource } from "./source.js";
import { probe, assertDuration, summarizeInfo, type VideoInfo } from "./probe.js";
import { download } from "./download.js";
import { extractFrames, type Frame, type ImageFormat } from "./frames.js";
import { transcribe, toTimestampedText, type TranscriptResult } from "./transcribe.js";
import { formatTimestamp, humanBytes } from "./paths.js";
import type { AvvConfig } from "./config.js";

export interface WatchOptions {
  source: string;
  /** How many stills to sample across the video. */
  frames?: number;
  /** Include a spoken-word transcript. */
  transcript?: boolean;
  /** Longest edge of each frame in pixels. */
  maxWidth?: number;
  format?: ImageFormat;
  /** Also produce a single tiled overview image. */
  contactSheet?: boolean;
  /** Keep the downloaded video and frames here instead of scratch. */
  dir?: string;
  /** Whisper model override. */
  model?: string;
  language?: string;
  timeoutSec?: number;
  signal?: AbortSignal;
  onProgress?: (stage: string, detail?: string) => void;
}

export interface WatchResult {
  info: VideoInfo;
  frames: Frame[];
  transcript: TranscriptResult | null;
  contactSheetPath?: string;
  localVideoPath: string;
  downloadedFrom?: string;
  frameDir: string;
  /** True when timestamps were drawn onto the frames themselves. */
  framesLabelled: boolean;
  /** Why the transcript is missing, when it is. */
  transcriptError?: string;
}

/**
 * Everything an agent needs to understand a video, in one call.
 *
 * Downloads once, then samples frames and transcribes speech from that same
 * local copy. The caller gets timestamped stills alongside timestamped words,
 * so it can line up what was said with what was on screen.
 */
export async function watch(opts: WatchOptions, cfg: AvvConfig): Promise<WatchResult> {
  const {
    frames: frameCount = 12,
    transcript: wantTranscript = true,
    maxWidth = 1024,
    format = "jpg",
    contactSheet = false,
    signal,
    onProgress,
  } = opts;

  const src = await resolveSource(opts.source, cfg);

  onProgress?.("probing", "reading metadata");
  const initialInfo = await probe(src, cfg, signal);
  assertDuration(initialInfo, cfg);

  // Fetch once, at a resolution that serves both jobs: 720p is more than enough
  // detail for 1024px stills, and the audio track rides along for Whisper.
  let localVideoPath: string;
  let downloadedFrom: string | undefined;
  let info = initialInfo;

  if (src.kind === "url") {
    onProgress?.("downloading", initialInfo.title);
    const dl = await download(
      {
        source: src.url,
        quality: "720p",
        format: "mp4",
        ...(opts.dir ? { dir: opts.dir } : {}),
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
  }

  onProgress?.("sampling", `${frameCount} frames`);
  const framesPromise = info.hasVideo
    ? extractFrames(
        {
          source: localVideoPath,
          count: frameCount,
          maxWidth,
          format,
          contactSheet,
          label: true,
          ...(opts.dir ? { dir: path.join(opts.dir, "frames") } : {}),
          ...(signal ? { signal } : {}),
          ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
        },
        cfg,
      )
    : Promise.resolve(null);

  const transcriptPromise =
    wantTranscript && info.hasAudio
      ? transcribe(
          {
            source: localVideoPath,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.language ? { language: opts.language } : {}),
            ...(signal ? { signal } : {}),
            ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
            onProgress: (p) => onProgress?.("transcribing", `${p}%`),
          },
          cfg,
        )
      : Promise.resolve(null);

  // Transcription is the fragile half (it needs whisper.cpp plus a model
  // download). Frames are still genuinely useful on their own, so a missing
  // Whisper degrades the result instead of failing the call.
  const [framesResult, transcriptSettled] = await Promise.all([
    framesPromise,
    transcriptPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
    ),
  ]);

  return {
    info,
    frames: framesResult?.frames ?? [],
    transcript: transcriptSettled.ok ? transcriptSettled.value : null,
    ...(framesResult?.contactSheetPath ? { contactSheetPath: framesResult.contactSheetPath } : {}),
    localVideoPath,
    ...(downloadedFrom ? { downloadedFrom } : {}),
    frameDir: framesResult?.dir ?? "",
    framesLabelled: framesResult?.labelled ?? false,
    ...(transcriptSettled.ok ? {} : { transcriptError: transcriptSettled.error }),
  };
}

/**
 * Render a watch result as text for an agent's context.
 *
 * The frames themselves travel as separate image blocks; this is the map that
 * tells the model what it is looking at and when each still was taken.
 */
export function renderWatchText(res: WatchResult, opts: { transcriptGroupSec?: number } = {}): string {
  const out: string[] = [];

  out.push(summarizeInfo(res.info));
  out.push("");

  if (res.downloadedFrom) {
    out.push(`Local copy: ${res.localVideoPath}`);
  }

  if (res.frames.length) {
    out.push("");
    out.push(
      `${res.frames.length} frames sampled across the video (each is attached as an image, in order):`,
    );
    out.push(
      res.frames
        .map((f) => `  ${String(f.index).padStart(2, " ")}. ${f.timestamp}`)
        .join("\n"),
    );
    if (!res.framesLabelled) {
      out.push(
        "(This ffmpeg has no drawtext filter, so the times above are not drawn on the images. " +
          "Match them by position: the Nth image is the Nth entry in the list.)",
      );
    }
    if (res.contactSheetPath) out.push(`Contact sheet: ${res.contactSheetPath}`);
  } else if (!res.info.hasVideo) {
    out.push("");
    out.push("(No video track - this is an audio-only source, so there are no frames.)");
  }

  if (res.transcript) {
    const grouped = toTimestampedText(res.transcript.segments, opts.transcriptGroupSec ?? 30);
    out.push("");
    out.push(
      `Transcript (${res.transcript.segments.length} segments, model "${res.transcript.model}"` +
        `${res.transcript.language ? `, language ${res.transcript.language}` : ""}):`,
    );
    out.push(grouped || "(no speech detected)");
  } else if (res.transcriptError) {
    out.push("");
    out.push(`Transcript unavailable: ${res.transcriptError}`);
  }

  return out.join("\n");
}

/** One-line headline used by the CLI. */
export function watchHeadline(res: WatchResult): string {
  const bits = [
    res.info.title,
    res.info.durationSec !== null ? formatTimestamp(res.info.durationSec) : null,
    `${res.frames.length} frames`,
    res.transcript ? `${res.transcript.segments.length} transcript segments` : "no transcript",
    res.info.filesizeBytes ? humanBytes(res.info.filesizeBytes) : null,
  ].filter(Boolean);
  return bits.join("  |  ");
}
