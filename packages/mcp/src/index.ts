#!/usr/bin/env node
/**
 * avv MCP server - lets an agent download, convert, and actually watch videos.
 *
 * On stdio, stdout carries the MCP protocol itself. Nothing here may write to
 * it: every diagnostic goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import {
  loadConfig, isAvvError, toAvvError,
  probe, resolveSource, summarizeInfo,
  download, summarizeDownload,
  convert, clip, summarizeConvert, TARGET_FORMATS,
  extractFrames, frameToBase64, mimeFor,
  transcribe, formatTranscript, toTimestampedText,
  watch, renderWatchText,
  checkTools, resolveFfmpeg, resolveDrawtextFfmpeg, humanBytes, formatTimestamp,
  type Frame, type ImageFormat, type TargetFormat, type Quality,
} from "@avv/core";

const cfg = loadConfig();

const server = new McpServer(
  { name: "avv", version: "0.1.0" },
  {
    instructions:
      "Tools for working with video from a URL or a local file.\n\n" +
      "Start with `video_watch` when you need to understand what a video actually contains - " +
      "it returns sampled frames as images plus a timestamped transcript in one call. " +
      "Use `video_info` first if you only need metadata and want to avoid a download. " +
      "Use `video_frames` to look more closely at specific moments you already know about.\n\n" +
      "Downloads default to ~/Downloads/avv and are confined to the user's home directory.",
  },
);

/* --------------------------------------------------------------- helpers */

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function ok(blocks: ContentBlock[] | string) {
  return {
    content: (typeof blocks === "string" ? [{ type: "text" as const, text: blocks }] : blocks),
  };
}

/**
 * Turn a thrown value into a tool error the agent can act on.
 *
 * AvvError carries a remediation string; surfacing it here is what lets an
 * agent fix a missing binary or a bad path by itself instead of stalling.
 */
function fail(e: unknown) {
  const err = isAvvError(e) ? e : toAvvError(e);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: err.toDisplay() }],
  };
}

/** Guard against dumping a whole book into the agent's context. */
function clampText(text: string, maxChars: number, what: string): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n\n[...truncated: ${what} is ${text.length} characters. ` +
    `Re-run with a narrower time range, or read the written file for the full text.]`
  );
}

async function framesToBlocks(frames: Frame[], format: ImageFormat): Promise<ContentBlock[]> {
  const mimeType = mimeFor(format);
  return await Promise.all(
    frames.map(async (f) => ({ type: "image" as const, data: await frameToBase64(f), mimeType })),
  );
}

const SOURCE_DESC =
  "A video URL (YouTube, Vimeo, or any site yt-dlp supports) or the path to a local video file.";

/* ------------------------------------------------------------ video_info */

server.registerTool(
  "video_info",
  {
    title: "Get video metadata",
    description:
      "Read a video's metadata without downloading it: title, duration, resolution, uploader, " +
      "chapters, and available subtitle languages. Cheap and fast - call this first when you " +
      "only need to know what something is, or to check the length before committing to a download.",
    inputSchema: {
      source: z.string().describe(SOURCE_DESC),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ source }) => {
    try {
      const src = await resolveSource(source, cfg);
      const info = await probe(src, cfg);
      return ok(summarizeInfo(info));
    } catch (e) {
      return fail(e);
    }
  },
);

/* ----------------------------------------------------------- video_watch */

server.registerTool(
  "video_watch",
  {
    title: "Watch a video",
    description:
      "Understand what a video contains. Samples frames evenly across it and returns them as " +
      "images, each labelled with its timestamp, alongside a locally-transcribed, timestamped " +
      "transcript of the speech. This is the tool to reach for when asked what a video shows, " +
      "says, or explains. Downloads the video once and reuses it for both jobs.\n\n" +
      "Cost note: each frame costs roughly 800 vision tokens, so 12 frames is about 10k tokens. " +
      "Raise `frames` for visually dense material, lower it for talking-head footage.",
    inputSchema: {
      source: z.string().describe(SOURCE_DESC),
      frames: z.number().int().min(1).max(32).default(12)
        .describe("How many stills to sample across the whole video."),
      transcript: z.boolean().default(true)
        .describe("Include a Whisper transcript of the speech."),
      maxWidth: z.number().int().min(256).max(1568).default(1024)
        .describe("Longest edge of each frame in pixels. Larger costs more vision tokens."),
      contactSheet: z.boolean().default(false)
        .describe("Also write a single tiled overview image of every frame to disk."),
      dir: z.string().optional()
        .describe("Keep the downloaded video and frames here instead of a scratch directory."),
      language: z.string().optional()
        .describe("Spoken language hint, e.g. \"en\". Defaults to auto-detect."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ source, frames, transcript, maxWidth, contactSheet, dir, language }) => {
    try {
      const res = await watch(
        {
          source,
          frames,
          transcript,
          maxWidth,
          contactSheet,
          ...(dir ? { dir } : {}),
          ...(language ? { language } : {}),
        },
        cfg,
      );

      const text = clampText(renderWatchText(res), 60_000, "the transcript");
      const images = await framesToBlocks(res.frames, "jpg");
      return ok([{ type: "text", text }, ...images]);
    } catch (e) {
      return fail(e);
    }
  },
);

/* ---------------------------------------------------------- video_frames */

server.registerTool(
  "video_frames",
  {
    title: "Extract frames from a video",
    description:
      "Pull specific stills out of a video and return them as images. Use `timestamps` to look " +
      "closely at moments you already care about (for example after `video_watch` showed you " +
      "roughly where something happens), or `count` with a sampling mode to survey the video. " +
      "Frames are written to disk and also returned inline.",
    inputSchema: {
      source: z.string().describe(SOURCE_DESC),
      timestamps: z.array(z.number().min(0)).optional()
        .describe("Exact times in seconds to capture. Takes precedence over `count`."),
      count: z.number().int().min(1).max(32).default(9)
        .describe("How many frames to sample when `timestamps` is not given."),
      mode: z.enum(["uniform", "scene", "keyframe"]).default("uniform")
        .describe("uniform spreads evenly; scene picks visual cuts; keyframe uses encoded keyframes."),
      maxWidth: z.number().int().min(256).max(1568).default(1024)
        .describe("Longest edge of each frame in pixels."),
      format: z.enum(["jpg", "png", "webp"]).default("jpg"),
      label: z.boolean().default(true).describe("Burn the timestamp onto each frame."),
      contactSheet: z.boolean().default(false).describe("Also write one tiled overview image."),
      dir: z.string().optional().describe("Where to write the frames."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ source, timestamps, count, mode, maxWidth, format, label, contactSheet, dir }) => {
    try {
      const res = await extractFrames(
        {
          source,
          ...(timestamps?.length ? { timestamps } : { count }),
          mode,
          maxWidth,
          format,
          label,
          contactSheet,
          ...(dir ? { dir } : {}),
        },
        cfg,
      );

      const lines = [
        `${res.frames.length} frames from "${res.info.title}" (written to ${res.dir}):`,
        ...res.frames.map((f) => `  ${String(f.index).padStart(2, " ")}. ${f.timestamp}  ${path.basename(f.path)}`),
      ];
      if (res.contactSheetPath) lines.push(`Contact sheet: ${res.contactSheetPath}`);

      const images = await framesToBlocks(res.frames, format);
      return ok([{ type: "text", text: lines.join("\n") }, ...images]);
    } catch (e) {
      return fail(e);
    }
  },
);

/* ------------------------------------------------------- video_transcribe */

server.registerTool(
  "video_transcribe",
  {
    title: "Transcribe speech from a video",
    description:
      "Transcribe the spoken audio of a video or audio file using Whisper, running locally on " +
      "this machine - no API key and nothing leaves the computer. Returns timestamped text by " +
      "default. Use this when you need the words but not the picture; use `video_watch` when you " +
      "need both.",
    inputSchema: {
      source: z.string().describe(SOURCE_DESC),
      format: z.enum(["segments", "text", "srt", "vtt"]).default("segments")
        .describe("segments = timestamped paragraphs (best for reading); srt/vtt = subtitle files."),
      language: z.string().optional().describe("Language hint, e.g. \"en\". Defaults to auto-detect."),
      model: z.string().optional()
        .describe("Whisper model: tiny, base, small, medium, large-v3-turbo. Bigger is slower and better."),
      translate: z.boolean().default(false).describe("Translate to English instead of transcribing verbatim."),
      dir: z.string().optional().describe("Also write .txt, .srt and .vtt files here."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ source, format, language, model, translate, dir }) => {
    try {
      const res = await transcribe(
        {
          source,
          translate,
          ...(language ? { language } : {}),
          ...(model ? { model } : {}),
          ...(dir ? { dir } : {}),
        },
        cfg,
      );

      const body = formatTranscript(res, format);
      const header = [
        `Transcript of "${res.info.title}"`,
        `Model: ${res.model}${res.language ? `  Language: ${res.language}` : ""}  Segments: ${res.segments.length}`,
        res.files.length ? `Written: ${res.files.join(", ")}` : "",
        "",
      ].filter(Boolean).join("\n");

      return ok(header + clampText(body, 100_000, "this transcript"));
    } catch (e) {
      return fail(e);
    }
  },
);

/* -------------------------------------------------------- video_download */

server.registerTool(
  "video_download",
  {
    title: "Download a video",
    description:
      "Download a video or its audio to disk. Returns the path of the file that was written. " +
      "Use `quality: \"audio\"` with a format like mp3 to rip just the sound. Downloads land in " +
      "~/Downloads/avv unless `dir` says otherwise, and are confined to the user's home directory.",
    inputSchema: {
      source: z.string().describe("A video URL. Local paths are returned unchanged."),
      dir: z.string().optional().describe("Destination directory. Defaults to ~/Downloads/avv."),
      quality: z.enum(["best", "2160p", "1440p", "1080p", "720p", "480p", "360p", "audio"]).default("best")
        .describe("Cap the resolution, or use \"audio\" to fetch sound only."),
      format: z.enum(["mp4", "mkv", "webm", "mp3", "m4a", "wav", "opus", "flac", "aac"]).optional()
        .describe("Container for video, or codec when quality is \"audio\". Defaults to mp4 / mp3."),
      filename: z.string().optional().describe("Output filename without extension. Defaults to the video title."),
      subtitles: z.boolean().default(false).describe("Also write subtitle files as .srt."),
      playlist: z.boolean().default(false).describe("Download every item when the URL is a playlist."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ source, dir, quality, format, filename, subtitles, playlist }) => {
    try {
      const res = await download(
        {
          source,
          quality: quality as Quality,
          subtitles,
          playlist,
          ...(dir ? { dir } : {}),
          ...(format ? { format: format as never } : {}),
          ...(filename ? { filename } : {}),
        },
        cfg,
      );
      return ok(summarizeDownload(res));
    } catch (e) {
      return fail(e);
    }
  },
);

/* --------------------------------------------------------- video_convert */

server.registerTool(
  "video_convert",
  {
    title: "Convert a video or extract its audio",
    description:
      "Convert media to another format. Works straight from a URL - passing a YouTube link with " +
      "`to: \"mp3\"` downloads and converts in one step. Swapping containers without re-encoding " +
      "is detected automatically, which is fast and lossless. Also handles gif export.",
    inputSchema: {
      source: z.string().describe(SOURCE_DESC),
      to: z.enum(TARGET_FORMATS as [TargetFormat, ...TargetFormat[]])
        .describe("Target format. mp3/m4a/wav/opus/flac/aac produce audio only."),
      dir: z.string().optional().describe("Destination directory. Defaults to ~/Downloads/avv."),
      filename: z.string().optional().describe("Output filename without extension."),
      maxHeight: z.number().int().min(120).max(4320).optional()
        .describe("Cap the output height in pixels, preserving aspect ratio."),
      fps: z.number().min(1).max(120).optional().describe("Force an output frame rate."),
      crf: z.number().int().min(0).max(51).default(23)
        .describe("Video quality for re-encodes. Lower is better; 18-28 is the useful range."),
      startSec: z.number().min(0).optional().describe("Trim: start time in seconds."),
      endSec: z.number().min(0).optional().describe("Trim: end time in seconds."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ source, to, dir, filename, maxHeight, fps, crf, startSec, endSec }) => {
    try {
      const section =
        startSec !== undefined && endSec !== undefined ? { startSec, endSec } : undefined;
      const res = await convert(
        {
          source,
          to,
          crf,
          ...(dir ? { dir } : {}),
          ...(filename ? { filename } : {}),
          ...(maxHeight !== undefined ? { maxHeight } : {}),
          ...(fps !== undefined ? { fps } : {}),
          ...(section ? { section } : {}),
        },
        cfg,
      );
      return ok(summarizeConvert(res));
    } catch (e) {
      return fail(e);
    }
  },
);

/* ------------------------------------------------------------ video_clip */

server.registerTool(
  "video_clip",
  {
    title: "Cut a segment out of a video",
    description:
      "Extract a time range as its own file. When the source is a URL only that range is " +
      "downloaded, so clipping 30 seconds out of a two-hour video stays cheap.",
    inputSchema: {
      source: z.string().describe(SOURCE_DESC),
      startSec: z.number().min(0).describe("Start time in seconds."),
      endSec: z.number().min(0).describe("End time in seconds. Must be after startSec."),
      dir: z.string().optional().describe("Destination directory. Defaults to ~/Downloads/avv."),
      filename: z.string().optional().describe("Output filename without extension."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ source, startSec, endSec, dir, filename }) => {
    try {
      const res = await clip(
        {
          source, startSec, endSec,
          ...(dir ? { dir } : {}),
          ...(filename ? { filename } : {}),
        },
        cfg,
      );
      return ok(
        `Clipped ${formatTimestamp(startSec)} to ${formatTimestamp(endSec)}\n` +
          `Path: ${res.path}\nSize: ${humanBytes(res.sizeBytes)}`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

/* ---------------------------------------------------------------- doctor */

server.registerTool(
  "video_doctor",
  {
    title: "Check the video toolchain",
    description:
      "Report which external tools are installed (ffmpeg, ffprobe, yt-dlp, whisper.cpp) and how " +
      "to install any that are missing. Call this when another tool fails with a missing-binary error.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const tools = await checkTools(cfg);
      const lines = tools.map((t) => {
        const mark = t.found ? "OK  " : "MISSING";
        const detail = t.found
          ? `${t.version ?? ""} (${t.path})`
          : t.path
            ? `- ${t.hint}`
            : `- install with: ${t.hint}`;
        return `${mark.padEnd(8)} ${t.name.padEnd(8)} ${detail}`;
      });
      const drawtext = await resolveFfmpeg("ffmpeg").then(resolveDrawtextFfmpeg).catch(() => null);
      lines.push("");
      lines.push(
        drawtext
          ? "Frame timestamps: drawn onto each frame."
          : "Frame timestamps: NOT drawn onto frames - this ffmpeg lacks the drawtext filter. " +
            "Frames come back unlabelled; match the Nth image to the Nth entry in the frame list. " +
            "To enable: brew install ffmpeg-full, then set AVV_FFMPEG_PATH to its ffmpeg.",
      );
      lines.push("");
      lines.push(`Downloads:     ${cfg.downloadDir}`);
      lines.push(`Cache:         ${cfg.home}`);
      lines.push(`Allowed roots: ${cfg.allowedRoots.join(", ")}`);
      lines.push(`Whisper model: ${cfg.whisperModel}`);
      lines.push(`Limits:        max ${formatTimestamp(cfg.maxDurationSec)} duration, ${cfg.maxFilesizeMb} MB, ${cfg.maxFrames} frames`);
      const missing = tools.filter((t) => !t.found);
      if (missing.length) {
        lines.push("");
        lines.push(`${missing.length} tool(s) missing. yt-dlp installs itself on first use; the others need the command shown above.`);
      }
      return ok(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

/* ------------------------------------------------------------------ boot */

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("avv MCP server ready on stdio\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`avv MCP server failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
