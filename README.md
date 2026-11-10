# FrameForge Studio

A local-first desktop app that turns a written brief into a finished MP4 — without a
video-generation subscription, and without a backend of its own.

```
brief + length ──► your LLM (your key, direct) ──► animated HTML per scene
                                                        │
                                   Chromium frame capture (offscreen)
                                                        │
                        FFmpeg: normalize → join → H.264 → MP4 + poster
```

One key is enough: DeepSeek, OpenRouter, Groq, or a local Ollama. The model writes the
storyboard and the animated scenes; this machine draws and encodes them.

## The four integrations

| Requirement | How it is implemented | Where |
|---|---|---|
| **HyperFrames UI** | The whole control surface is built from `@hyperframes/studio` primitives (Tabs, Button, Input, Select, Toggle, Tooltip, Pill, loader) on the HyperFrames tokens; `@hyperframes/player` renders composition previews | `src/renderer/src/**`, `package.json` |
| **OfficeCLI orchestration** | A process stage shells out to `officecli` for document deliverables (delivery `.pptx`, plus the fallback storyboard `.docx` path), with discovery, sanitised env and JSON parsing | `src/main/office/index.ts` |
| **FFmpeg rendering** | Local encode: probe, normalise, crossfade/join, PNG-sequence → H.264, poster extraction. FFmpeg is a hard requirement for rendering | `src/main/ffmpeg/**` |
| **OS-native key vault** | Windows Credential Manager / macOS Keychain / Secret Service via `@napi-rs/keyring`, with Electron `safeStorage` (DPAPI/Keychain) fallback and memory-only last resort. Secrets never leave the main process | `src/main/vault.ts` |

No backend server exists. Every network call originates in the main process, with the
user's own key, against the host the user configured.

## The free pipeline

`providerId: 'motion'` is the default and only engine in the workflow.

1. **validate** — FFmpeg present, a language model configured, brief non-empty.
2. **storyboard** — one `POST {base}/chat/completions` returns 2–8 scenes
   (`title`, `durationSeconds`, `html`). Durations are rescaled to the requested length.
3. **generate** — each scene is sanitised, wrapped with the app's pause/seek driver,
   captured frame-by-frame in an offscreen `BrowserWindow`, and encoded to H.264.
4. **download** — skipped; nothing is fetched.
5. **compose** — opening/closing brand cards, captured and encoded the same way.
6. **render** — every segment normalised to one pixel format/size/fps, then joined with
   cuts or crossfades.
7. **export** — MP4, poster frame, `storyboard.json`.

A scene that fails validation falls back to a branded card so the film still completes.
Paid video adapters (Runway, Luma, fal, Replicate, HeyGen, Sora) remain in
`src/main/providers/` for a future video-backed mode, but are unreachable from the UI:
no job can require one of their keys.

## Security posture

- **Sandboxed renderer**: `contextIsolation`, no Node integration, strict CSP
  (`default-src 'none'`), denied navigation, denied permissions, denied webviews.
- **Secrets stay in main**: the renderer can set/test/delete a key but never read one;
  disk metadata holds only the last 4 characters and a SHA-256 fingerprint.
- **Untrusted model output**: scene HTML has `<script>`, `<iframe>`, `<object>`, `<embed>`,
  `<link>`, `<form>`, `<base>` removed, inline `on*` handlers stripped, and remote
  `src`/`href`/`url()`/`@import` neutralised before capture. Capture runs under
  `default-src 'none'`, so a missed reference still cannot fetch.
- **Per-client allowlist**: the HTTP client is built from the user's base URL, so only that
  host is reachable, and only for that client. Loopback allowed only when the user typed it.

## Layout

```
src/
  main/
    index.ts          window, ffcomp:// scheme, smoke harness
    ipc.ts            typed IPC, zod re-validation
    vault.ts          keyring → safeStorage → memory
    security.ts       CSP, hardening
    settings.ts       non-secret model config
    scenes.ts         scene schema, prompts, sanitiser, driver injection
    providers/        llm.ts (universal) · video adapters (not in the UI)
    jobs/             store.ts · runner.ts (seven stages)
    ffmpeg/           locate · probe/normalise/concat/encode/poster
    render/cards.ts   offscreen capture
    office/           OfficeCLI wrapper
  preload/index.ts    contextBridge surface
  renderer/src/       App · StudioView · JobsView · KeysView · SystemView
  shared/             contract (zod) · bridge types · composition
tests/                vitest: 72 tests across 9 files
scripts/              smoke, smoke:job, mock model, mock provider, docs
docs/                 GUIDE.md + PDF manual
```

## Run it

```
pnpm install
pnpm dev            # electron-vite dev
pnpm typecheck      # strict TS, zero any
pnpm test           # 72 tests, real FFmpeg renders included
pnpm build          # bundle
pnpm dist           # NSIS installer in release/
```

Optical check and end-to-end check (both need no account):

```
pnpm smoke          # boots the app, verifies bridge/vault/toolchain
pnpm smoke:job      # three-scene render through the real UI against a local mock model
```

`smoke:job` starts `scripts/mock-openai.mjs`, points `FRAMEFORGE_SMOKE_LLM_URL` at it, runs
a job in the real renderer, then ffprobes the exported MP4.

## Keys

**Keys → Custom / Universal provider** takes a provider name, base URL, model id and key.
Presets cover DeepSeek (`https://api.deepseek.com/v1`, `deepseek-chat`), OpenRouter, Groq
and Ollama. Stored under `provider:custom` in the OS credential store.

## Notes and limits

- The output has no audio track; add music in an editor, or extend the compose stage.
- Capture is realtime-independent but CPU-bound: 30 fps × 1080p × seconds.
- macOS/Linux installers need to be built on those platforms.
- `signAndEditExecutable: false` is set because NSIS needs symlink privileges on this
  machine; the exe keeps Electron's default icon even though shortcuts use the brand icon.
- Model HTML is the creative ceiling: a stronger model makes better scenes. The schema and
  sanitiser are the guardrails.
