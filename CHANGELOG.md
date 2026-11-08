# Changelog

## 3.0.0 — 2026-11-08: ChatGPT + Claude Backup

The repository is renamed from **claude-export-hub** to **chatgpt-claude-backup**, and the extension now covers both sites.

- **One extension for Claude and ChatGPT.** The ChatGPT archiver from [chatgpt-attachment-downloader](https://github.com/lekandigital/chatgpt-attachment-downloader) (unreleased `full-archive` branch, 1.2.0) is merged in. Its source is in `src/chatgpt/`, and it builds into `chatgpt/`.
- **New popup** with a Claude tab and a ChatGPT tab: *Back up this chat*, *Back up this project*, *Choose chats…* and *Back up all chats*, a folder setting, and a live *Last backup* status.
- **Chat picker** on both backup pages: load your chat list, filter by title or project, tick chats.
- **Projects**
  - Project mode (`project=`) backs up a project's chats and the project itself.
  - Backing up a single chat or chosen chats now also saves their projects. Before, ChatGPT dropped the project name, and neither site saved the project folder.
  - Claude projects also save `memory.json`/`memory.md` (project memory) and `syncs.json` (synced knowledge sources) when present. Full Claude runs save account memory to `_account/memory.json`.
  - Claude project mode also reads the project's own chat list. Starter projects missing from the projects list now get their real name.
- **Fixes**
  - ChatGPT: every live archive since the 2026-11-08 re-render refactor failed at the last step of each chat. It saved the files but wrote no `manifest.json` and marked the chat failed (`title`/`thinking` were no longer defined).
  - Claude: a Cloudflare "Just a moment…" 403 now reloads the background tab and retries instead of failing the run.
  - Claude: failed project docs/files lists are logged instead of skipped silently.
- **Automation:** one `automation.js` for both sites. `#ccb=` is new; the older `#ceh=` and `#cga=` prefixes still work. The archiver is picked by site.
- The older tools remain: Claude ZIP export and ChatGPT attachments & transcript.
- New icon. The ChatGPT transcript footer now reads "ChatGPT + Claude Backup".

Earlier history: Claude Export Hub 2.x is in this repository's git log. ChatGPT Attachment Downloader 1.x is in [docs/chatgpt/CHANGELOG.md](docs/chatgpt/CHANGELOG.md).
