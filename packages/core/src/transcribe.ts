import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AvvError } from "./errors.js";
import { run } from "./exec.js";
import { resolveWhisper, resolveWhisperModel } from "./binaries.js";
import { resolveSource } from "./source.js";
import { probe, assertDuration, type VideoInfo } from "./probe.js";
import { download } from "./download.js";
import { toSpeechWav, cleanup } from "./convert.js";
import { cachePaths, type AvvConfig } from "./config.js";
import { ensureDir, exists, resolveAllowed, sanitizeFilename, formatTimestamp } from "./paths.js";

export type TranscriptFormat = "text" | "srt" | "vtt" | "segments";

export interface TranscribeOptions {
  source: string;
  /** ISO language code, or "auto" to detect. */
  language?: string;
  /** whisper.cpp model. Larger is more accurate and slower. */
  model?: string;
  /** Write the transcript to this directory as well as returning it. */
  dir?: string;
  /** Translate to English rather than transcribing in the source language. */
  translate?: boolean;
  timeoutSec?: number;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
  /** The full transcript as one block of text. */
  text: string;
  language: string | null;
  model: string;
  info: VideoInfo;
  /** Written transcript files, when `dir` was given. */
  files: string[];
  downloadedFrom?: string;
}

/** whisper.cpp `-oj` output. */
interface WhisperJson {
  result?: { language?: string };
  transcription?: {
    offsets?: { from?: number; to?: number };
    timestamps?: { from?: string; to?: string };
    text?: string;
  }[];
}

/**
 * Transcribe a video or audio source with a locally-run Whisper model.
 *
 * Everything happens on this machine: no API key, no upload, and it works the
 * same for a YouTube link, a Vimeo link, or a screen recording sitting in
 * ~/Desktop. The first run for a given model downloads its weights once.
 */
export async function transcribe(opts: TranscribeOptions, cfg: AvvConfig): Promise<TranscriptResult> {
  const { language = "auto", translate = false, signal, onProgress } = opts;
  const model = opts.model ?? cfg.whisperModel;

  const whisper = await resolveWhisper();
  const src = await resolveSource(opts.source, cfg);

  let mediaPath: string;
  let info: VideoInfo;
  let downloadedFrom: string | undefined;
  let fetchedFile: string | undefined;

  if (src.kind === "url") {
    // Audio-only keeps the download small; Whisper never looks at the picture.
    const dl = await download(
      {
        source: src.url,
        quality: "audio",
        format: "m4a",
        ...(signal ? { signal } : {}),
        ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
      },
      cfg,
    );
    mediaPath = dl.path;
    info = dl.info;
    downloadedFrom = src.url;
    fetchedFile = dl.path;
  } else {
    mediaPath = src.path;
    info = await probe(src, cfg, signal);
  }

  if (!info.hasAudio) {
    throw new AvvError(
      "NO_AUDIO_STREAM",
      `"${info.title}" has no audio track to transcribe.`,
      "Use `frames` or `watch` to inspect the picture instead.",
      { title: info.title },
    );
  }
  assertDuration(info, cfg);

  const modelPath = await resolveWhisperModel(cfg, model);

  const scratch = await ensureDir(cachePaths(cfg).tmp);
  const stem = sanitizeFilename(info.title, 60);
  const wavPath = path.join(scratch, `${stem}-${process.pid}.wav`);
  const outPrefix = path.join(scratch, `${stem}-${process.pid}-transcript`);

  try {
    await toSpeechWav(mediaPath, wavPath, cfg, signal);

    const args = [
      "-m", modelPath,
      "-f", wavPath,
      "-oj",
      "-of", outPrefix,
      "-t", String(Math.max(1, Math.min(8, os.cpus().length - 1))),
      "-pp",
    ];
    if (language && language !== "auto") args.push("-l", language);
    else args.push("-l", "auto");
    if (translate) args.push("-tr");

    await run(whisper, args, {
      timeoutMs: (opts.timeoutSec ?? cfg.timeoutSec) * 1000,
      ...(signal ? { signal } : {}),
      onStderr: (line) => {
        if (!onProgress) return;
        const m = line.match(/progress\s*=\s*(\d+)%/i);
        if (m?.[1]) onProgress(Number.parseInt(m[1], 10));
      },
    });

    const jsonPath = `${outPrefix}.json`;
    if (!(await exists(jsonPath))) {
      throw new AvvError(
        "SUBPROCESS_FAILED",
        "whisper.cpp finished but wrote no transcript.",
        `Check that the model at ${modelPath} is a complete download; delete it and retry to re-fetch.`,
        { modelPath },
      );
    }

    const raw = JSON.parse(await fs.readFile(jsonPath, "utf8")) as WhisperJson;
    const segments: TranscriptSegment[] = (raw.transcription ?? [])
      .map((s) => ({
        startSec: (s.offsets?.from ?? 0) / 1000,
        endSec: (s.offsets?.to ?? 0) / 1000,
        text: (s.text ?? "").trim(),
      }))
      .filter((s) => s.text.length > 0);

    const text = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();

    const files: string[] = [];
    if (opts.dir) {
      const outDir = await ensureDir(await resolveAllowed(opts.dir, cfg));
      const base = path.join(outDir, stem);
      await fs.writeFile(`${base}.txt`, text, "utf8");
      await fs.writeFile(`${base}.srt`, toSrt(segments), "utf8");
      await fs.writeFile(`${base}.vtt`, toVtt(segments), "utf8");
      files.push(`${base}.txt`, `${base}.srt`, `${base}.vtt`);
    }

    await cleanup(jsonPath);

    return {
      segments,
      text,
      language: raw.result?.language ?? (language === "auto" ? null : language),
      model,
      info,
      files,
      ...(downloadedFrom ? { downloadedFrom } : {}),
    };
  } finally {
    await cleanup(wavPath);
    // The fetched audio is scratch too, unless it landed in the user's own
    // download directory because they asked for it there.
    if (fetchedFile && fetchedFile.startsWith(cachePaths(cfg).tmp)) await cleanup(fetchedFile);
  }
}

/* ------------------------------------------------------------- formatting */

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(milli).padStart(3, "0")}`;
}

export function toSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${srtTime(s.startSec)} --> ${srtTime(s.endSec)}\n${s.text}\n`)
    .join("\n");
}

export function toVtt(segments: TranscriptSegment[]): string {
  const body = segments
    .map((s) => `${srtTime(s.startSec).replace(",", ".")} --> ${srtTime(s.endSec).replace(",", ".")}\n${s.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/**
 * Merge segments into readable paragraphs with a timestamp on each.
 *
 * Whisper emits a segment every few seconds, which is far too granular to put
 * in an agent's context. Grouping into ~30s blocks keeps the timing useful
 * while cutting the token count several-fold.
 */
export function toTimestampedText(segments: TranscriptSegment[], groupSec = 30): string {
  if (!segments.length) return "";
  const blocks: { start: number; parts: string[] }[] = [];
  let current = { start: segments[0]!.startSec, parts: [] as string[] };

  for (const seg of segments) {
    if (seg.startSec - current.start >= groupSec && current.parts.length) {
      blocks.push(current);
      current = { start: seg.startSec, parts: [] };
    }
    current.parts.push(seg.text);
  }
  if (current.parts.length) blocks.push(current);

  return blocks
    .map((b) => `[${formatTimestamp(b.start)}] ${b.parts.join(" ").replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

export function formatTranscript(result: TranscriptResult, format: TranscriptFormat): string {
  switch (format) {
    case "srt":
      return toSrt(result.segments);
    case "vtt":
      return toVtt(result.segments);
    case "segments":
      return toTimestampedText(result.segments);
    case "text":
    default:
      return result.text;
  }
}
