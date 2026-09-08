/**
 * @avv/core - the engine behind the `avv` CLI and the avv MCP server.
 *
 * Everything here is transport-agnostic: no MCP types, no argv parsing, no
 * console output. Both front-ends are thin wrappers over these functions.
 */

export { AvvError, isAvvError, toAvvError, type AvvErrorCode } from "./errors.js";
export { run, canRun, tail, type RunOptions, type RunResult } from "./exec.js";
export { loadConfig, cachePaths, expandHome, type AvvConfig } from "./config.js";
export {
  resolveAllowed, ensureDir, exists, uniquePath, fileSize, sanitizeFilename,
  freeDiskBytes, assertDiskSpace, humanBytes, formatTimestamp,
} from "./paths.js";
export {
  resolveFfmpeg, resolveYtDlp, resolveWhisper, resolveWhisperModel,
  checkTools, installYtDlpViaBrew, isStandaloneYtDlp,
  type ToolName, type ToolStatus,
} from "./binaries.js";
export { resolveSource, isPrivateAddress, sourceLabel, type Source } from "./source.js";
export {
  probe, probeUrl, probeLocalFile, assertDuration, assertFilesize, summarizeInfo,
  type VideoInfo, type Chapter,
} from "./probe.js";
export {
  download, summarizeDownload, QUALITIES,
  type DownloadOptions, type DownloadResult, type DownloadProgress,
  type Quality, type AudioFormat, type VideoContainer,
} from "./download.js";
export {
  convert, clip, toSpeechWav, cleanup, summarizeConvert, isAudioFormat, TARGET_FORMATS,
  type ConvertOptions, type ConvertResult, type TargetFormat,
} from "./convert.js";
export {
  extractFrames, frameToBase64, uniformTimestamps, mimeFor,
  type FrameOptions, type FramesResult, type Frame, type FrameMode, type ImageFormat,
} from "./frames.js";
export {
  transcribe, toSrt, toVtt, toTimestampedText, formatTranscript,
  type TranscribeOptions, type TranscriptResult, type TranscriptSegment, type TranscriptFormat,
} from "./transcribe.js";
export {
  watch, renderWatchText, watchHeadline,
  type WatchOptions, type WatchResult,
} from "./watch.js";
