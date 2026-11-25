# CLAUDE.md

Open Generative AI: Next.js web app + Electron desktop app (`app/`, `src/`, `electron/`) with a shared React
studio library (`packages/studio`). Cloud generation goes through MuAPI (paid); the desktop app also has free
local engines (sd.cpp for images, Wan2GP for video) in `electron/lib/`.

## Claude agent (`claude-agent/`)

Lets Claude generate images, narration and narrated multi-scene videos (≤ 120 s) on the user's command.

- MCP server: `claude-agent/src/server.mjs` (registered in `.mcp.json` as `open-generative-ai`, tools `oga_*`).
- CLI: `node claude-agent/bin/oga.mjs <doctor|setup|image|tts|clip|produce|models|download|wan2gp>`.
- Skill with the full workflow: `.claude/skills/produtor-de-video/SKILL.md`. User guide (pt-BR): `claude-agent/README.md`.
- It reuses the electron-free modules in `electron/lib/` (model catalogs, sd.cpp runtime helpers, Wan2GP local/MCP
  clients, downloader) — keep those modules free of `electron` imports.
- Generated media goes to `outputs/` (git-ignored).
- YouTube upload (`claude-agent/src/youtube/`, guide `claude-agent/YOUTUBE.md`): OAuth desktop flow with PKCE, tokens
  in an encrypted vault outside the repo, resumable `videos.insert`. Upload only when the user asks; default `private`;
  `public`/`unlisted`/`publish_at` only on explicit request. Never ask for or echo client secrets, codes or tokens.

## Rules

- **Every finished video is delivered as a downloadable MP4.** As soon as a render is final (after QA), send the
  MP4 to the user as an attachment in the conversation (SendUserFile, `display: "attach"`), with resolution,
  duration, codecs and the SHA-256 from `manifest.json` (`sha256`) in the caption. Never hand over only an
  internal path. If attachments are unavailable, use a safe fallback, in this order: (1) publish a private
  Artifact page holding the MP4 as an uploaded asset (≤ 15 MB) and give its link; (2) on the user's own machine,
  give the full local path of `outputs/…` (the file is already theirs). Never upload media to public hosts.
- Free/local engines first. Never call MuAPI (paid) or pass `allow_paid: true` without the user's explicit consent
  for that generation. Paid calls also require `MUAPI_API_KEY` and `OGA_ALLOW_PAID=1` in the environment.
- Never commit API keys or secrets; keys come from environment variables only.
- Do not loosen Electron security defaults (see CONTRIBUTING.md).

## Commands

```bash
npm run setup                       # submodules + install + build workspace packages
npm test                            # app tests + agent tests (node --test)
cd claude-agent && npm install && npm test   # agent only
node claude-agent/bin/oga.mjs doctor          # what works on this machine
```
