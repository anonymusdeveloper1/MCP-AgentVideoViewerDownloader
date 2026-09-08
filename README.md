# avv — agent video viewer & downloader

An MCP server and CLI that let an AI agent **download, convert, and actually watch** video.

Agents are good with text and blind to video. Hand one a YouTube link and, at best, it
guesses from the title. `avv` closes that gap: one tool call turns a URL into timestamped
still frames the model can *see*, plus a locally-transcribed, timestamped record of
everything said.

```
  https://youtu.be/…  ─┬─►  frames  ──►  the agent's own vision
                       └─►  speech  ──►  local Whisper  ──►  timestamped text
```

No API keys. No uploads. Transcription runs on your machine.

---

## What you get

Two front-ends over one shared engine:

| Package | What it is |
|---|---|
| `@avv/core` | The engine: yt-dlp + ffmpeg + whisper.cpp orchestration. No CLI, no MCP, no I/O assumptions. |
| `avv-mcp` | MCP server exposing 8 tools over stdio. For agents. |
| `avv` | Command-line binary. For you — and for agents that can't speak MCP but can shell out. |

Both front-ends are thin. All the logic lives in `core`, so the CLI and the MCP server can
never drift apart.

---

## Install

**Requirements:** Node 20+, and ffmpeg.

```bash
brew install ffmpeg yt-dlp whisper-cpp
```

Then:

```bash
git clone https://github.com/anonymusdeveloper1/MCP-AgentVideoViewerDownloader.git
cd MCP-AgentVideoViewerDownloader
npm install
npm run build
```

Check the toolchain:

```bash
node packages/cli/dist/index.js doctor
```

`yt-dlp` self-installs into `~/.avv/bin` on first use if it's missing, so `brew` is optional
for it — but see [the yt-dlp note](#a-note-on-yt-dlp) below, because the Homebrew build is
dramatically faster.

### Wire it into an agent

```bash
claude mcp add avv -- node /absolute/path/to/packages/mcp/dist/index.js
```

Or paste into your MCP client config:

```json
{
  "mcpServers": {
    "avv": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"]
    }
  }
}
```

`avv mcp-config` prints this for you with your paths already filled in.

---

## The tools

| Tool | What it does |
|---|---|
| `video_watch` | **The main one.** Frames + transcript + metadata in one call. Downloads once, reuses it for both. |
| `video_info` | Metadata only — title, duration, chapters, subtitle languages. No download. |
| `video_frames` | Stills at specific timestamps, or sampled by scene change / keyframe. |
| `video_transcribe` | Speech to timestamped text, SRT, or VTT. Runs locally. |
| `video_download` | Fetch a video or just its audio, at a chosen quality. |
| `video_convert` | Format conversion, straight from a URL. mp4 ⇄ mp3 ⇄ webm ⇄ gif ⇄ … |
| `video_clip` | Cut a time range. For URLs, downloads *only* that range. |
| `video_doctor` | Report which external tools are present and how to install the rest. |

### How `video_watch` works

1. Probe the source for metadata and refuse anything absurd (livestreams, 5-hour videos).
2. Download **once**, at 720p — plenty for 1024px stills, and the audio rides along.
3. In parallel: sample N frames evenly across the runtime, and transcribe the audio.
4. Return the frames as MCP image blocks, plus text pairing each frame index to its
   timestamp and grouping the transcript into ~30-second blocks.

Frames are sampled at the *midpoint* of each slice rather than at boundaries — that avoids
the black frames and title cards that cluster at the start and end of most videos.

Transcription is the fragile half (it needs whisper.cpp and a model download). If it fails,
the frames still come back with a note explaining why the transcript is missing, rather than
the whole call failing.

**Token cost:** roughly 800 vision tokens per frame, so the default 12 frames is about
10k tokens. Raise it for visually dense material, lower it for a talking head.

---

## CLI

```bash
avv info      "https://youtu.be/dQw4w9WgXcQ"
avv watch     "https://youtu.be/dQw4w9WgXcQ" -n 12
avv download  "https://youtu.be/dQw4w9WgXcQ" -q 1080p -d ~/clips
avv convert   "https://youtu.be/dQw4w9WgXcQ" --to mp3
avv transcribe ~/Movies/standup.mov -f srt -d ~/subs
avv frames    ~/Movies/demo.mp4 -t 12,45,90
avv clip      "https://youtu.be/dQw4w9WgXcQ" --start 60 --end 90
avv doctor --install
```

Every command takes `--json` for machine-readable output. Progress goes to stderr, results
to stdout, so `avv watch … --json | jq` works cleanly.

Exit codes: `0` success, `1` failure, `2` bad usage, `3` a required tool is missing.

---

## Configuration

All optional; sensible defaults throughout.

| Variable | Default | Purpose |
|---|---|---|
| `AVV_DOWNLOAD_DIR` | `~/Downloads/avv` | Where downloads land. |
| `AVV_ALLOWED_ROOTS` | `$HOME:$TMPDIR:~/.avv` | Colon-separated roots writes are confined to. |
| `AVV_HOME` | `~/.avv` | Cache for binaries, Whisper models, scratch. |
| `AVV_WHISPER_MODEL` | `base` | `tiny` … `large-v3-turbo`. Bigger is slower and better. |
| `AVV_MAX_DURATION_SEC` | `14400` (4h) | Refuse longer sources. |
| `AVV_MAX_FILESIZE_MB` | `4096` | Refuse larger downloads. |
| `AVV_MIN_FREE_DISK_MB` | `1024` | Headroom to preserve. |
| `AVV_MAX_FRAMES` | `64` | Hard cap on frames per call. |
| `AVV_TIMEOUT_SEC` | `1800` | Per-operation wall clock. |
| `AVV_FFMPEG_PATH` / `AVV_YTDLP_PATH` / `AVV_WHISPER_PATH` | auto | Override binary discovery. |

---

## Safety

This tool takes URLs and filesystem paths from an AI agent, which may be acting on
instructions embedded in a web page or a video description. It is built accordingly:

- **No shell, ever.** Every subprocess is spawned with an argv array. A filename containing
  `; rm -rf ~` is a filename, not a command.
- **Writes are confined** to an allow-list, symlinks resolved before the check. `/etc`,
  `/System` and `/usr` are unreachable by default.
- **SSRF blocked.** Hostnames are resolved and refused if they land on loopback, link-local,
  RFC1918, CGNAT, or unique-local addresses. Cloud metadata endpoints are named explicitly.
- **Resource guards.** Maximum duration, maximum filesize, and a free-disk check before any
  download starts. Livestreams are refused outright.
- **Process trees are killed on timeout** — yt-dlp shells out to ffmpeg, and killing only the
  parent would orphan the child.

Both refusal paths are covered by `scripts/smoke-mcp.mjs`.

## Legality

`avv` drives [yt-dlp](https://github.com/yt-dlp/yt-dlp), which is legal software. What you do
with it is your responsibility. Downloading copyrighted material you have no right to may
breach the terms of service of the site you take it from, and may be unlawful where you live.
Use it for content you own, content licensed for reuse, or content you have permission to
download.

---

## A note on yt-dlp

There are two ways to get yt-dlp, and the difference is not small:

| Source | Startup, per invocation |
|---|---|
| `brew install yt-dlp` | **~0.25s** |
| Standalone `yt-dlp_macos` binary | **~11s** |

The standalone build is a PyInstaller bundle that re-extracts its embedded Python on *every*
run — not just the first. A single `watch` invokes yt-dlp two or three times, so that's the
difference between an imperceptible pause and half a minute of dead air.

`avv` auto-provisions the standalone build when yt-dlp is missing, because it needs no
Homebrew and no Python and therefore always works. But `avv doctor --install` prefers
Homebrew when it's available, and `doctor` flags the slow build when it's in use.

---

## Development

```bash
npm run build                                    # build all three packages
npm run rebuild                                  # clean rebuild
npx tsc --noEmit -p packages/core                # typecheck
node scripts/smoke-mcp.mjs ~/some/video.mp4      # end-to-end MCP test
```

```
packages/
  core/src/
    exec.ts        the only place a process is spawned
    source.ts      URL vs file, SSRF guard
    paths.ts       allow-list confinement, sanitising, disk checks
    binaries.ts    locating and provisioning ffmpeg / yt-dlp / whisper
    probe.ts       metadata via ffprobe and yt-dlp
    download.ts    yt-dlp orchestration
    convert.ts     ffmpeg conversion, clipping, speech-wav prep
    frames.ts      frame sampling, contact sheets
    transcribe.ts  whisper.cpp
    watch.ts       the orchestrator that fuses all of it
  mcp/src/index.ts  8 tools over stdio
  cli/src/index.ts  commander front-end
```

### Frame timestamps

Frames carry their timestamp burned into the corner, which lets a model anchor what it sees
to when it happened without counting image positions.

This needs ffmpeg's `drawtext` filter, which needs libfreetype at build time — and Homebrew's
plain `ffmpeg` bottle is built without it. So `avv` looks for a capable build:

```bash
brew install ffmpeg-full
```

It is keg-only (installed outside PATH), and `avv` finds it automatically — no configuration.
If no capable ffmpeg exists, frames come back unlabelled and the response says so, telling the
caller to match the Nth image to the Nth entry in the frame list.

`avv doctor` reports which mode you are in under **Capabilities**.

> **Careful:** installing `ffmpeg-full` upgrades shared libraries (x265 among them) and can
> leave an older `ffmpeg` pointing at a `.dylib` that no longer exists. If ffmpeg suddenly
> fails with `Library not loaded`, run `brew reinstall ffmpeg`. `avv doctor` detects this
> exact case and prints the fix.

## Licence

MIT
