<div align="center">

<img src="img/sinmal.svg" alt="Sinmal" width="140" />

# Sinmal

**Detect and download the MP4, HLS and DASH videos a page is playing — straight from the browser.**

A Manifest V3 extension that watches the tab's traffic, lists the videos it finds and rebuilds
streams into a single MP4 locally with ffmpeg compiled to WebAssembly. No server, no upload, no middleman.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![ffmpeg.wasm](https://img.shields.io/badge/ffmpeg.wasm-0.12-007808?logo=ffmpeg&logoColor=white)
![esbuild](https://img.shields.io/badge/esbuild-0.23-FFCF00?logo=esbuild&logoColor=black)
![Node](https://img.shields.io/badge/Node-20.x-339933?logo=node.js&logoColor=white)

</div>

---

## The problem

A video playing on a page is not always a file you can save. Modern streams arrive in pieces:
**HLS** and **DASH** deliver dozens or hundreds of segments, often with video and audio on
separate tracks, and the whole video only exists assembled inside the player.

The usual way out is an ad-heavy download site that asks for the URL, processes it on someone
else's server and returns whatever it decides to return.

Sinmal does the work **inside the browser**. It sees what the tab loads, shows what it found,
and downloads and remuxes the segments locally. Not one byte goes through an external server.

---

## Features

- **Automatic detection** — MP4, HLS (`.m3u8`) and DASH (`.mpd`) recognized by content type, with the URL extension as a second clue.
- **Preview before downloading** — each video shows a thumbnail built from the start of the file itself.
- **Quality picker with size estimates** — every resolution in the manifest, with an estimated size (`720p · ~48 MB`).
- **Audio only** — when the stream has a separate audio track, download just the audio as `.m4a`, no re-encode.
- **Live progress** — percentage, speed and time left, then the remux and save stages.
- **Cancel anytime** — the download button becomes a cancel button while a job runs, including mid-remux.
- **Resilient to flaky networks** — failed segments are retried automatically.
- **Sensible file names** — files are named after the page title, not `index.m3u8`.
- **Protected streams refused upfront** — encrypted playlists (HLS keys / DRM) fail with a clear message instead of halfway through.

<details>
<summary><b>How detection avoids noise</b></summary>

<br>

Any modern page generates a lot of background traffic, so detection is deliberately strict:

- **Loose segments and audio-only responses are ignored** (`.ts`, `.m4s`, `.cmfv`, `.cmfa`, `audio/*`). What matters is the file, or the manifest that gathers the pieces.
- **Every MP4 candidate is probed** — the header is read to confirm a video track exists, which keeps ads and image-less preloads off the list.
- **Master playlists win** — when the same tab serves a master playlist and its variants, the variants are dropped: the master already covers them.
- **Activity window** — the content script reports when a `<video>` enters the viewport or starts playing, and detection only counts within **15 seconds** of that activity.

</details>

<details>
<summary><b>How a stream becomes one MP4</b></summary>

<br>

```
manifest (.m3u8 / .mpd)
   │  parse variants, pick quality
   ▼
segments ──fetch (with session cookies, Range for byte-ranges, retries)──▶ bytes
   │  fMP4: init segment first   │  MPEG-TS: widened probe window
   ▼
ffmpeg.wasm  -c copy  -movflags faststart   (remux, never re-encode)
   │
   ▼
Blob ──▶ service worker ──▶ chrome.downloads
```

**Retry rules.** A segment that fails with a network error, `5xx`, `408` or `429` is retried up to
three times with growing back-off. A `403` fails right away — an expired signed URL stays
expired, and retrying would only waste time.

**Size estimate.** `bitrate / 8 × duration`. For HLS it uses `AVERAGE-BANDWIDTH` when the
playlist declares it (plain `BANDWIDTH` is the peak and overestimates); every variant shares the
same duration, so only one variant playlist is fetched. For DASH the duration comes from
`mediaPresentationDuration`.

**Cancel.** An `AbortController` runs through the whole chain: fetches stop, retry back-offs
stop, and mid-remux the ffmpeg.wasm instance is terminated (the next job loads a fresh one).
Temp files in ffmpeg's in-memory filesystem are removed on failure and cancel too, since the
instance is reused between downloads.

</details>

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Platform | **Chrome Manifest V3** | Service worker, `webRequest` for detection, `downloads` for saving, `offscreen` for heavy work. |
| Language | **TypeScript 5** (strict) | Messages between extension parts are a discriminated union — a new message doesn't compile until it's handled. |
| Media | **ffmpeg.wasm 0.12** | Real ffmpeg in the browser: stream-copy remux of HLS/DASH into MP4. |
| Build | **esbuild** via an 80-line script | No framework bundler; ESM for extension pages, IIFE for the content script. |
| CI/CD | **GitHub Actions** | Every `v*` tag typechecks, builds and publishes a ready-to-load `.zip` release. |

### Notable decisions

**An offscreen document, not the service worker.** ffmpeg.wasm needs Web Workers and Blobs, and
the MV3 service worker has neither. Downloading and remuxing live in an offscreen document; the
service worker only detects videos and hands the final file to the downloads API.

**No CDN, ever.** The MV3 content security policy forbids remote code, so the ffmpeg worker is
re-bundled locally and the wasm core is copied into `dist/` at build time.

**No server — on purpose.** A download proxy would add cost, latency and a privacy question
("who sees the URLs I download?") for zero gain. Requests carry the user's own session cookies,
which is exactly what lets it download videos the user already has access to.

---

## Architecture

```
src/
├── background.ts         Service worker: detection, variant listing, offscreen lifecycle, downloads
├── content/content.ts    Content script: reports on-screen / playing <video> elements
├── popup/                Popup UI: video list, previews, quality picker, progress, cancel
├── offscreen/            Offscreen document: runs download jobs, owns the AbortControllers
├── hls/                  Playlist parser (master / variant, byte-ranges, keys) and HLS remux
├── dash/                 MPD parser (SegmentTemplate / SegmentList / BaseURL) and DASH remux
├── media/
│   ├── ffmpeg.ts         ffmpeg.wasm loader, segment fetch with retry, exec, cleanup
│   └── mp4probe.ts       Reads the MP4 header to confirm a video track exists
├── icons/                Extension icons, generated from img/sinmal.svg
├── types.ts              Shared types and the message union
└── util.ts               Formatting and size estimation helpers
```

```
┌─────────────┐  VIDEO_VISIBLE   ┌──────────────────────────┐
│ content.ts  │ ───────────────▶ │  background.ts (SW)      │◀── webRequest: tab responses
└─────────────┘                  │  detect · list variants  │
                                 └──────┬─────────────▲─────┘
                    GET_VIDEOS /        │             │ SAVE_BLOB_URL
                    REQUEST_DOWNLOAD    │             │
┌─────────────┐ ◀───────────────────────┘     ┌───────┴──────────────┐
│  popup.ts   │ ─── CANCEL_JOB ─────────────▶ │  offscreen.ts        │
│             │ ◀── DOWNLOAD_PROGRESS/DONE ── │  fetch · ffmpeg.wasm │
└─────────────┘                               └──────────────────────┘
```

---

## Getting Started

### Prerequisites

- **Node.js 20.x**
- npm
- Chrome (or another Chromium browser) with Developer mode enabled

### Build and load

```bash
git clone https://github.com/maat-aug/videoSaver.git
cd videoSaver
npm ci
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick the
`dist/` folder.

Rather not build? Grab the packaged `.zip` from the [releases](../../releases) and load it the same way.

### Scripts

| Script | What it does |
|---|---|
| `npm run build` | Production build into `dist/` |
| `npm run watch` | Rebuilds on change (reload the extension in `chrome://extensions`) |
| `npm run typecheck` | `tsc --noEmit` — the automated gate in CI |
| `npm run clean` | Removes `dist/` |

---

## Releases

Pushing a `v*` tag triggers [`release.yml`](.github/workflows/release.yml):

```
checkout → setup Node 20 → npm ci → typecheck → build → zip dist/ → GitHub Release
```

The release ships `sinmal-<tag>.zip`, ready for **Load unpacked** after extracting.

---

## Limitations

- **DRM and encrypted HLS** are refused by design.
- **Live streams** only capture the segments currently listed in the playlist.
- **Very long or high-bitrate videos** are remuxed in memory, so they are bound by the browser tab's RAM.
- **HLS packed audio** (raw `.aac` renditions) is not remuxed yet.

Only download content you have the right to keep.

---

## Author

[![GitHub](https://img.shields.io/badge/GitHub-maat--aug-181717?logo=github&logoColor=white)](https://github.com/maat-aug)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Matheus_Augusto-0A66C2?logo=linkedin&logoColor=white)](https://linkedin.com/in/matheus-augusto-a89348265)
