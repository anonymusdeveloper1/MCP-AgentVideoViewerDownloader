#!/usr/bin/env node
/**
 * avv - download, convert, and watch videos from the command line.
 *
 * Every command supports `--json` so an agent that cannot speak MCP can shell
 * out to this and parse the result.
 */
import { Command, Option } from "commander";
import path from "node:path";
import {
  loadConfig, isAvvError, toAvvError,
  resolveSource, probe, summarizeInfo,
  download, summarizeDownload,
  convert, clip, summarizeConvert, TARGET_FORMATS,
  extractFrames,
  transcribe, formatTranscript,
  watch, renderWatchText, watchHeadline,
  checkTools, resolveYtDlp, resolveWhisperModel, installYtDlpViaBrew,
  humanBytes, formatTimestamp,
  type TargetFormat, type Quality, type TranscriptFormat, type FrameMode, type ImageFormat,
} from "@avv/core";

const cfg = loadConfig();
const isTty = process.stdout.isTTY === true;

/** Progress goes to stderr so `--json` stdout stays clean and pipeable. */
function progress(line: string): void {
  if (!isTty) return;
  process.stderr.write(`\r\x1b[2K${line}`);
}

function endProgress(): void {
  if (isTty) process.stderr.write("\r\x1b[2K");
}

function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/**
 * Exit codes are part of the contract for anything scripting this:
 * 1 = something went wrong, 2 = bad usage, 3 = a required tool is missing.
 */
function die(e: unknown): never {
  endProgress();
  const err = isAvvError(e) ? e : toAvvError(e);
  if (globalJson()) {
    process.stdout.write(JSON.stringify(err.toJSON(), null, 2) + "\n");
  } else {
    process.stderr.write(`\n${err.toDisplay()}\n`);
  }
  const code = err.code === "BINARY_MISSING" || err.code === "MODEL_MISSING" ? 3 : err.code === "BAD_ARGUMENT" ? 2 : 1;
  process.exit(code);
}

const program = new Command();
let jsonMode = false;
function globalJson(): boolean {
  return jsonMode;
}

program
  .name("avv")
  .description("Download, convert, and watch videos - built for humans and AI agents.")
  .version("0.1.0")
  .option("--json", "emit machine-readable JSON instead of formatted text", false)
  .hook("preAction", (thisCommand) => {
    jsonMode = Boolean(thisCommand.opts().json);
  });

/* ------------------------------------------------------------------ info */

program
  .command("info")
  .description("Show a video's metadata without downloading it")
  .argument("<source>", "video URL or local file path")
  .action(async (source: string) => {
    try {
      const src = await resolveSource(source, cfg);
      const info = await probe(src, cfg);
      if (globalJson()) emitJson(info);
      else out(summarizeInfo(info));
    } catch (e) {
      die(e);
    }
  });

/* ----------------------------------------------------------------- watch */

program
  .command("watch")
  .description("Sample frames and transcribe a video so you (or an agent) can understand it")
  .argument("<source>", "video URL or local file path")
  .option("-n, --frames <count>", "how many frames to sample", "12")
  .option("--no-transcript", "skip transcription")
  .option("-w, --max-width <px>", "longest edge of each frame", "1024")
  .option("--contact-sheet", "also write one tiled overview image", false)
  .option("-d, --dir <dir>", "keep the video and frames here")
  .option("-l, --language <code>", "spoken language hint, e.g. en")
  .action(async (source: string, o: { frames: string; transcript: boolean; maxWidth: string; contactSheet: boolean; dir?: string; language?: string }) => {
    try {
      const res = await watch(
        {
          source,
          frames: Number.parseInt(o.frames, 10),
          transcript: o.transcript,
          maxWidth: Number.parseInt(o.maxWidth, 10),
          contactSheet: o.contactSheet,
          ...(o.dir ? { dir: o.dir } : {}),
          ...(o.language ? { language: o.language } : {}),
          onProgress: (stage, detail) => progress(`  ${stage}${detail ? `: ${detail}` : ""}...`),
        },
        cfg,
      );
      endProgress();

      if (globalJson()) {
        emitJson({
          title: res.info.title,
          durationSec: res.info.durationSec,
          localVideoPath: res.localVideoPath,
          frameDir: res.frameDir,
          contactSheetPath: res.contactSheetPath ?? null,
          frames: res.frames.map((f) => ({ index: f.index, timeSec: f.timeSec, timestamp: f.timestamp, path: f.path })),
          transcript: res.transcript
            ? { language: res.transcript.language, model: res.transcript.model, segments: res.transcript.segments }
            : null,
          transcriptError: res.transcriptError ?? null,
        });
      } else {
        out(renderWatchText(res));
        out("");
        out(watchHeadline(res));
      }
    } catch (e) {
      die(e);
    }
  });

/* -------------------------------------------------------------- download */

program
  .command("download")
  .alias("dl")
  .description("Download a video or its audio")
  .argument("<source>", "video URL")
  .option("-d, --dir <dir>", "destination directory")
  .addOption(
    new Option("-q, --quality <quality>", "resolution cap, or 'audio' for sound only")
      .choices(["best", "2160p", "1440p", "1080p", "720p", "480p", "360p", "audio"])
      .default("best"),
  )
  .option("-f, --format <format>", "container (mp4/mkv/webm) or audio codec (mp3/m4a/wav/opus/flac/aac)")
  .option("-o, --filename <name>", "output filename without extension")
  .option("-s, --subtitles", "also download subtitles as .srt", false)
  .option("--playlist", "download every item when the URL is a playlist", false)
  .action(async (source: string, o: { dir?: string; quality: string; format?: string; filename?: string; subtitles: boolean; playlist: boolean }) => {
    try {
      const res = await download(
        {
          source,
          quality: o.quality as Quality,
          subtitles: o.subtitles,
          playlist: o.playlist,
          ...(o.dir ? { dir: o.dir } : {}),
          ...(o.format ? { format: o.format as never } : {}),
          ...(o.filename ? { filename: o.filename } : {}),
          onProgress: (p) =>
            progress(`  ${p.stage} ${p.percent.toFixed(1)}%${p.speed ? ` at ${p.speed}` : ""}${p.eta ? ` ETA ${p.eta}` : ""}`),
        },
        cfg,
      );
      endProgress();
      if (globalJson()) {
        emitJson({ path: res.path, sizeBytes: res.sizeBytes, title: res.info.title, subtitles: res.subtitlePaths });
      } else {
        out(summarizeDownload(res));
      }
    } catch (e) {
      die(e);
    }
  });

/* --------------------------------------------------------------- convert */

program
  .command("convert")
  .description("Convert media to another format, straight from a URL if you like")
  .argument("<source>", "video URL or local file path")
  .requiredOption("-t, --to <format>", `target format (${TARGET_FORMATS.join(", ")})`)
  .option("-d, --dir <dir>", "destination directory")
  .option("-o, --filename <name>", "output filename without extension")
  .option("--max-height <px>", "cap the output height, preserving aspect ratio")
  .option("--fps <fps>", "force an output frame rate")
  .option("--crf <crf>", "video quality for re-encodes; lower is better", "23")
  .option("--start <sec>", "trim start, in seconds")
  .option("--end <sec>", "trim end, in seconds")
  .action(async (source: string, o: { to: string; dir?: string; filename?: string; maxHeight?: string; fps?: string; crf: string; start?: string; end?: string }) => {
    try {
      if (!TARGET_FORMATS.includes(o.to as TargetFormat)) {
        process.stderr.write(`Unknown format "${o.to}". Choose one of: ${TARGET_FORMATS.join(", ")}\n`);
        process.exit(2);
      }
      const section =
        o.start !== undefined && o.end !== undefined
          ? { startSec: Number.parseFloat(o.start), endSec: Number.parseFloat(o.end) }
          : undefined;

      const res = await convert(
        {
          source,
          to: o.to as TargetFormat,
          crf: Number.parseInt(o.crf, 10),
          ...(o.dir ? { dir: o.dir } : {}),
          ...(o.filename ? { filename: o.filename } : {}),
          ...(o.maxHeight ? { maxHeight: Number.parseInt(o.maxHeight, 10) } : {}),
          ...(o.fps ? { fps: Number.parseFloat(o.fps) } : {}),
          ...(section ? { section } : {}),
          onProgress: (p) => progress(`  converting ${p.toFixed(1)}%`),
        },
        cfg,
      );
      endProgress();
      if (globalJson()) emitJson({ path: res.path, sizeBytes: res.sizeBytes, format: res.format, remuxed: res.remuxed });
      else out(summarizeConvert(res));
    } catch (e) {
      die(e);
    }
  });

/* ------------------------------------------------------------ transcribe */

program
  .command("transcribe")
  .alias("tr")
  .description("Transcribe speech locally with Whisper")
  .argument("<source>", "video URL or local file path")
  .addOption(
    new Option("-f, --format <format>", "output shape")
      .choices(["segments", "text", "srt", "vtt"])
      .default("segments"),
  )
  .option("-l, --language <code>", "language hint, e.g. en")
  .option("-m, --model <model>", "whisper model (tiny, base, small, medium, large-v3-turbo)")
  .option("--translate", "translate to English instead of transcribing verbatim", false)
  .option("-d, --dir <dir>", "also write .txt, .srt and .vtt here")
  .action(async (source: string, o: { format: string; language?: string; model?: string; translate: boolean; dir?: string }) => {
    try {
      const res = await transcribe(
        {
          source,
          translate: o.translate,
          ...(o.language ? { language: o.language } : {}),
          ...(o.model ? { model: o.model } : {}),
          ...(o.dir ? { dir: o.dir } : {}),
          onProgress: (p) => progress(`  transcribing ${p}%`),
        },
        cfg,
      );
      endProgress();
      if (globalJson()) {
        emitJson({ title: res.info.title, language: res.language, model: res.model, segments: res.segments, files: res.files });
      } else {
        out(formatTranscript(res, o.format as TranscriptFormat));
        if (res.files.length) process.stderr.write(`\nWritten: ${res.files.join(", ")}\n`);
      }
    } catch (e) {
      die(e);
    }
  });

/* ---------------------------------------------------------------- frames */

program
  .command("frames")
  .description("Extract still frames from a video")
  .argument("<source>", "video URL or local file path")
  .option("-n, --count <count>", "how many frames to sample", "9")
  .option("-t, --timestamps <list>", "comma-separated seconds to capture instead, e.g. 12,45,90")
  .addOption(
    new Option("-m, --mode <mode>", "sampling strategy").choices(["uniform", "scene", "keyframe"]).default("uniform"),
  )
  .option("-w, --max-width <px>", "longest edge of each frame", "1024")
  .addOption(new Option("--format <format>", "image format").choices(["jpg", "png", "webp"]).default("jpg"))
  .option("--no-label", "do not burn the timestamp onto each frame")
  .option("--contact-sheet", "also write one tiled overview image", false)
  .option("-d, --dir <dir>", "where to write the frames")
  .action(async (source: string, o: { count: string; timestamps?: string; mode: string; maxWidth: string; format: string; label: boolean; contactSheet: boolean; dir?: string }) => {
    try {
      const timestamps = o.timestamps
        ?.split(",")
        .map((s) => Number.parseFloat(s.trim()))
        .filter((n) => Number.isFinite(n));

      const res = await extractFrames(
        {
          source,
          ...(timestamps?.length ? { timestamps } : { count: Number.parseInt(o.count, 10) }),
          mode: o.mode as FrameMode,
          maxWidth: Number.parseInt(o.maxWidth, 10),
          format: o.format as ImageFormat,
          label: o.label,
          contactSheet: o.contactSheet,
          ...(o.dir ? { dir: o.dir } : {}),
          onProgress: (done, total) => progress(`  extracting frame ${done}/${total}`),
        },
        cfg,
      );
      endProgress();
      if (globalJson()) {
        emitJson({
          dir: res.dir,
          contactSheetPath: res.contactSheetPath ?? null,
          frames: res.frames.map((f) => ({ index: f.index, timeSec: f.timeSec, timestamp: f.timestamp, path: f.path, bytes: f.bytes })),
        });
      } else {
        out(`${res.frames.length} frames from "${res.info.title}" -> ${res.dir}`);
        for (const f of res.frames) {
          out(`  ${String(f.index).padStart(2, " ")}. ${f.timestamp}  ${path.basename(f.path)}  ${humanBytes(f.bytes)}`);
        }
        if (res.contactSheetPath) out(`Contact sheet: ${res.contactSheetPath}`);
      }
    } catch (e) {
      die(e);
    }
  });

/* ------------------------------------------------------------------ clip */

program
  .command("clip")
  .description("Cut a time range out of a video")
  .argument("<source>", "video URL or local file path")
  .requiredOption("-s, --start <sec>", "start time in seconds")
  .requiredOption("-e, --end <sec>", "end time in seconds")
  .option("-d, --dir <dir>", "destination directory")
  .option("-o, --filename <name>", "output filename without extension")
  .action(async (source: string, o: { start: string; end: string; dir?: string; filename?: string }) => {
    try {
      const res = await clip(
        {
          source,
          startSec: Number.parseFloat(o.start),
          endSec: Number.parseFloat(o.end),
          ...(o.dir ? { dir: o.dir } : {}),
          ...(o.filename ? { filename: o.filename } : {}),
        },
        cfg,
      );
      if (globalJson()) emitJson({ path: res.path, sizeBytes: res.sizeBytes });
      else out(`Clipped to ${res.path} (${humanBytes(res.sizeBytes)})`);
    } catch (e) {
      die(e);
    }
  });

/* ---------------------------------------------------------------- doctor */

program
  .command("doctor")
  .description("Check the toolchain and show how to fix anything missing")
  .option("--install", "provision what can be installed automatically (yt-dlp, Whisper model)", false)
  .action(async (o: { install: boolean }) => {
    try {
      if (o.install) {
        process.stderr.write("Provisioning yt-dlp...\n");
        // Homebrew's build starts in ~0.25s; the standalone bundle re-extracts
        // its embedded Python on every call and takes ~11s. Prefer brew, and
        // fall back to the self-contained download when brew is absent.
        let ytdlpPath = await installYtDlpViaBrew();
        if (ytdlpPath) {
          process.stderr.write("  installed via Homebrew\n");
        } else {
          ytdlpPath = await resolveYtDlp(cfg, { autoInstall: true });
        }
        process.stderr.write(`  yt-dlp ready at ${ytdlpPath}\n`);
        process.stderr.write(`Fetching Whisper model "${cfg.whisperModel}" (this can take a few minutes)...\n`);
        const m = await resolveWhisperModel(cfg);
        process.stderr.write(`  model ready at ${m}\n\n`);
      }

      const tools = await checkTools(cfg);
      if (globalJson()) {
        emitJson({ tools, config: { downloadDir: cfg.downloadDir, home: cfg.home, allowedRoots: cfg.allowedRoots, whisperModel: cfg.whisperModel } });
        if (tools.some((t) => !t.found)) process.exit(3);
        return;
      }

      out("Toolchain");
      for (const t of tools) {
        const status = t.found ? "  ok     " : "  MISSING";
        out(`${status} ${t.name.padEnd(8)} ${t.found ? `${t.version ?? ""} ${t.path ?? ""}`.trim() : `install with: ${t.hint}`}`);
      }
      out("");
      out("Configuration");
      out(`  downloads      ${cfg.downloadDir}`);
      out(`  cache          ${cfg.home}`);
      out(`  allowed roots  ${cfg.allowedRoots.join(", ")}`);
      out(`  whisper model  ${cfg.whisperModel}`);
      out(`  limits         max ${formatTimestamp(cfg.maxDurationSec)}, ${cfg.maxFilesizeMb} MB, ${cfg.maxFrames} frames`);

      const missing = tools.filter((t) => !t.found);
      if (missing.length) {
        out("");
        out(`${missing.length} tool(s) missing. Run \`avv doctor --install\` for the ones that can self-install.`);
        process.exit(3);
      }
    } catch (e) {
      die(e);
    }
  });

/* ------------------------------------------------------------- mcp-config */

program
  .command("mcp-config")
  .description("Print the MCP server config snippet to paste into a client")
  .action(() => {
    const snippet = {
      mcpServers: {
        avv: {
          command: "npx",
          args: ["-y", "avv-mcp"],
          env: {
            AVV_DOWNLOAD_DIR: cfg.downloadDir,
            AVV_WHISPER_MODEL: cfg.whisperModel,
          },
        },
      },
    };
    if (globalJson()) emitJson(snippet);
    else {
      out("Add this to your MCP client config (e.g. ~/.claude.json or claude_desktop_config.json):\n");
      out(JSON.stringify(snippet, null, 2));
      out("\nOr, with the Claude Code CLI:\n");
      out("  claude mcp add avv -- npx -y avv-mcp");
    }
  });

program.parseAsync(process.argv).catch((e: unknown) => die(e));
