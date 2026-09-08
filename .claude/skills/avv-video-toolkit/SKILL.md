---
name: avv-video-toolkit
description: Orientation for the avv repo - an MCP server and CLI that let AI agents download, convert, transcribe, and visually watch video. Read this before exploring, modifying, or using anything in this repository, and whenever a task here involves video, audio, frames, transcripts, yt-dlp, ffmpeg, whisper, MCP tools, or the `avv` command. It explains the three-package layout, which module owns what, exactly what the tools let an agent do and what they refuse to do, and several environment quirks that will otherwise cost you an hour of debugging.
---

# avv — agent video viewer & downloader

This repo solves one problem: **agents are blind to video.** Hand a model a YouTube link
and it guesses from the title. `avv` turns that link into still frames the model can
actually see, plus a locally-transcribed record of what was said.

If you are working in this repo, read the "Capabilities and limits" section before you do
anything else — it tells you what the tools will and will not do for you, which saves you
from writing code that fights the guardrails.

---

## The shape of it

Three packages, one engine. npm workspaces, TypeScript, ESM throughout.

```
packages/core/   @avv/core   the engine. no CLI, no MCP, no console output.
packages/mcp/    avv-mcp     8 tools over stdio, for agents.
packages/cli/    avv         commander binary, for humans and for agents that shell out.
```

The front-ends are deliberately thin. **All logic belongs in `core`.** If you find yourself
adding real behaviour to `mcp/src/index.ts` or `cli/src/index.ts`, it is in the wrong place —
the whole point of the split is that the CLI and MCP server cannot drift apart.

### Which module owns what

| File | Responsibility |
|---|---|
| `core/src/exec.ts` | **The only place a process is spawned.** Timeouts, process-group kills, line-wise progress. |
| `core/src/source.ts` | Is this a URL or a file? SSRF guard lives here. |
| `core/src/paths.ts` | Allow-list confinement, filename sanitising, disk-space checks, timestamp formatting. |
| `core/src/binaries.ts` | Finding and provisioning ffmpeg / yt-dlp / whisper + models. |
| `core/src/config.ts` | Every `AVV_*` environment variable, in one place. |
| `core/src/errors.ts` | `AvvError` with a `code` and a `remediation`. |
| `core/src/probe.ts` | Metadata via ffprobe (local) and yt-dlp (remote). Duration/filesize guards. |
| `core/src/download.ts` | yt-dlp orchestration, quality tiers, playlists, sections. |
| `core/src/convert.ts` | Format conversion, clipping, speech-wav prep for Whisper. |
| `core/src/frames.ts` | Frame sampling, contact sheets, drawtext capability probe. |
| `core/src/transcribe.ts` | whisper.cpp, plus SRT/VTT/grouped-text rendering. |
| `core/src/watch.ts` | The orchestrator that fuses download + frames + transcript. |

Read `core/src/index.ts` first — it is the public surface and the fastest map of the codebase.

---

## Capabilities and limits

This is the part most agents need. The tools give you real filesystem and network reach, and
they refuse a specific set of things on purpose. Knowing the boundary up front is faster than
discovering it through errors.

### What you can do

- **Read metadata from any public http/https URL** without downloading anything (`video_info`).
- **Download media to disk** — video or audio, at a chosen quality, anywhere inside the
  allowed roots (default: the user's home directory, the system temp dir, and `~/.avv`).
- **Write derived files**: converted media, clips, extracted frames, transcript `.txt`/`.srt`/`.vtt`.
- **Read local video files** from anywhere inside those same allowed roots.
- **See video content.** `video_watch` and `video_frames` return frames as MCP image blocks,
  so they land in your own vision, not in a summary written by another model.
- **Transcribe speech locally.** Whisper runs on the machine. No API key, nothing uploaded.

### What is refused, and why

These are not bugs to work around. The caller here may be acting on instructions embedded in
a web page or a video description, so the guardrails assume the request might be hostile.

| Refusal | Trigger |
|---|---|
| `PATH_NOT_ALLOWED` | Writing outside the allow-list, or a URL resolving to loopback / link-local / RFC1918 / CGNAT / unique-local / cloud-metadata addresses. Symlinks are resolved *before* the check. |
| `UNSUPPORTED_SOURCE` | Any scheme that is not `http:` or `https:`. |
| `TOO_LONG` | Livestreams (refused outright), or anything over `AVV_MAX_DURATION_SEC` (4h). |
| `TOO_LARGE` | Over `AVV_MAX_FILESIZE_MB` (4 GB). |
| `DISK_FULL` | The download would eat into the `AVV_MIN_FREE_DISK_MB` floor (1 GB). |
| `BINARY_MISSING` | ffmpeg / yt-dlp / whisper absent. The remediation string names the exact install command. |

Frames are also hard-capped at `AVV_MAX_FRAMES` (64) regardless of what you ask for.

### What it will never do

- **Never uses a shell.** Every subprocess gets an argv array, so a filename containing
  `; rm -rf ~` is a filename, not a command. If you add a subprocess call, use `run()` from
  `exec.ts` — do not reach for `exec` or `shell: true`.
- **Never overwrites.** `uniquePath()` appends ` (2)`, ` (3)` instead.
- **Never handles credentials.** No API keys, no cookies by default, no auth of any kind.
- **No network egress beyond** the media host and the provisioning endpoints (GitHub releases
  for yt-dlp, HuggingFace for Whisper models).

### Errors are designed for you to act on

Every `AvvError` carries a `remediation` string, and the MCP layer surfaces it in the tool
error. When a tool fails, the fix is usually stated verbatim in the response — read it before
inventing a workaround.

```
[BINARY_MISSING] whisper.cpp was not found on PATH.
How to fix: Install it with: brew install whisper-cpp
```

If you add a new failure mode, keep this contract: say what happened, then say what to do
about it. An agent that is told the exact command can unstick itself; one that gets
"operation failed" cannot.

---

## Using the tools

### Picking the right one

- **"What is in this video?" / "summarise this" / "what does it show?"** → `video_watch`.
  This is the default. It downloads once and returns frames plus transcript together.
- **"How long is it?" / "is this the right video?"** → `video_info`. No download, fast.
- **"Look closely at 4:32"** → `video_frames` with explicit `timestamps`. Use this *after*
  `video_watch` has shown you roughly where something happens.
- **"Just give me the words"** → `video_transcribe`.
- **"Save it" / "make it an mp3"** → `video_download` or `video_convert`.
- **"Cut out 1:00–1:30"** → `video_clip`. For URLs this downloads *only* that range.
- **A tool failed with a missing binary** → `video_doctor`.

### Cost awareness

Each frame costs roughly 800 vision tokens, so the default 12 frames is about 10k tokens.
Scale it to the material: a slide deck or a code screencast rewards more frames; a talking
head rewards fewer. Prefer raising `frames` over calling `video_watch` twice, since each call
re-samples from scratch.

Transcripts are grouped into ~30-second blocks before being returned. Whisper's raw segments
are far too granular to put in context, and the grouping cuts the token count several-fold
while keeping timestamps useful.

### From the command line

```bash
node packages/cli/dist/index.js watch "https://youtu.be/..." -n 12
node packages/cli/dist/index.js convert "https://youtu.be/..." --to mp3
node packages/cli/dist/index.js doctor
```

Every command takes `--json`. Progress goes to stderr, results to stdout, so
`avv watch … --json | jq` works. Exit codes: `0` ok, `1` failure, `2` bad usage,
`3` missing tool.

---

## Working on the code

```bash
npm install
npm run build                                 # all three packages
npm run rebuild                               # clean rebuild
npx tsc --noEmit -p packages/core             # typecheck core alone
node scripts/smoke-mcp.mjs ~/some/video.mp4   # end-to-end MCP test
```

`scripts/smoke-mcp.mjs` speaks real MCP over stdio and checks the handshake, tool listing,
image blocks, and both refusal paths. Run it after any change to `core` or `mcp` — it catches
whole classes of breakage that typechecking cannot.

### Conventions worth matching

- **Optional properties are spread, not assigned.** `exactOptionalPropertyTypes` is on, so
  write `...(dir ? { dir } : {})` rather than `dir: dir ?? undefined` — an explicit
  `undefined` is a type error, not a shrug. The distinction is real: "the caller said
  nothing" and "the caller said undefined" reach different code paths in yt-dlp and ffmpeg
  argument building.
- **Capability probes are cached module-level.** See `supportsDrawtext()` in `frames.ts`.
  External tools vary between machines; ask once, remember the answer, degrade gracefully.
- **Guards run before expensive work.** Duration, filesize, and disk checks all happen before
  a byte is downloaded.
- **Nothing writes to stdout in the MCP server.** On stdio, stdout *is* the protocol.
  Diagnostics go to stderr. This is the easiest way to break the server.

---

## Environment quirks that will cost you time

These were all found the hard way on macOS. They are handled at runtime rather than
documented away, but you should know they exist before you "fix" the code that handles them.

**Homebrew's ffmpeg has no `drawtext` filter.** The bottle is built without libfreetype, so
burning timestamps onto frames fails with `No such filter: 'drawtext'`. `frames.ts` probes for
it and falls back to unlabelled frames, telling the caller to match frames to times by
position. Do not remove that probe assuming ffmpeg is uniform across machines.

**The standalone yt-dlp binary costs ~11 seconds per invocation.** It is a PyInstaller bundle
that re-extracts its embedded Python on *every* run, not just the first. Homebrew's build
starts in ~0.25s. `avv` auto-provisions the standalone build (it needs no Python and therefore
always works), but `doctor --install` prefers Homebrew and `doctor` flags the slow path. If you
are benchmarking anything, check which one is on PATH first.

**TypeScript is pinned to 5.9.x on purpose.** TS 7.0.2 does not resolve `@types/node` at all —
every `import ... from "node:fs"` fails. Do not bump the major without verifying that first.

**Whisper's `base` model is mediocre.** It misheard "trunks" as "pumps" in testing. That is the
model, not a bug in the pipeline. Suggest `AVV_WHISPER_MODEL=small` or `large-v3-turbo` when
transcript accuracy matters.

---

## Configuration

Everything is optional; the defaults work with no setup. Full list in `.env.example`, defined
in `core/src/config.ts`. The ones that come up most:

| Variable | Default | Why you'd change it |
|---|---|---|
| `AVV_DOWNLOAD_DIR` | `~/Downloads/avv` | Put downloads somewhere else. |
| `AVV_ALLOWED_ROOTS` | `$HOME:$TMPDIR:~/.avv` | Widen or narrow where writes may land. |
| `AVV_WHISPER_MODEL` | `base` | Trade speed for transcript accuracy. |
| `AVV_MAX_DURATION_SEC` | `14400` | Allow longer sources. |
| `AVV_MAX_FRAMES` | `64` | Raise the per-call frame ceiling. |

## Legal posture

`avv` drives yt-dlp, which is legal software; what gets downloaded is the user's
responsibility. If a task involves bulk-downloading copyrighted material, say so plainly
rather than silently building the tooling for it. The README states this position — keep any
docs you write consistent with it.
