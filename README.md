# ChatGPT + Claude Backup

A Chrome extension that backs up your **ChatGPT** and **Claude** chats: one chat, a project, the chats you pick, or all of them. It saves everything it can reach, not just the text: thinking, pasted text, your uploads, the files the assistant made, canvases and artifacts, project instructions and knowledge files, and every edited or regenerated branch.

Everything runs in your own browser with your existing sign-in. Files go straight into your Downloads folder, one folder per chat. Nothing is sent anywhere else.

> This repository used to be **claude-export-hub**. The ChatGPT half comes from [chatgpt-attachment-downloader](https://github.com/lekandigital/chatgpt-attachment-downloader). Old links redirect here.

## Install

1. Clone or download this repository and keep the folder somewhere permanent.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the repository folder (the one with `manifest.json`).
3. Reload any claude.ai or chatgpt.com tabs that were already open.

No build step is needed: the built ChatGPT files in `chatgpt/` are committed. Chrome 111 or newer.

## Use

Click the toolbar icon. The popup opens on the **Claude** or **ChatGPT** tab, depending on the site you are on.

| Button | What it does |
|---|---|
| **Back up this chat** | Saves the open chat as one folder straight into Downloads, e.g. `Downloads/2026-11-08 Chat title [a1b2c3d4]/`. If the chat is in a project, the project's instructions and files go inside it, in `project/`. Progress shows in the popup. |
| **Back up this project** | Shown on a project page, or on a ChatGPT chat inside a project. Saves one folder named after the project, e.g. `Downloads/My project [1a2b3c4d]/`. It holds the project's settings, instructions and knowledge files (and, on Claude, project memory and synced sources), plus one folder per chat. |
| **Choose chats…** | Opens the backup page with your chat list: filter by title or project, tick chats (or **Choose all shown**), then **Archive listed chats**. Each chat is saved straight into Downloads as above. |
| **Back up all chats** | Asks once to confirm, then backs up the whole account into `Downloads/Claude Backup/` or `Downloads/ChatGPT Backup/`, followed by projects and account-level data. |

- A chat, chosen chats and a project are always saved fresh, with nothing else added to Downloads.
- **Back up all chats** remembers which chats that folder already has, so running it again only saves new or changed chats. Tick **Redo chats already saved there** (shown when you confirm) to refresh them anyway. To use another folder, such as an existing archive, type its name into **Folder inside Downloads** on the backup page.
- **Last backup** shows the latest run (live while it runs). **Show** jumps to its tab.
- Keep the backup tab open until it says *Done*. Closing the popup is fine.
- **Backup page** opens the full page with all options. The other link opens the older tools (see [Older tools](#older-tools)).

### How long it takes

- **Claude:** about a chat every few seconds, plus file downloads.
- **ChatGPT** limits chat reads to roughly one a minute after the first ~200 in a burst. A large account therefore takes many hours, and **your own ChatGPT use may be rate-limited while it runs**. When ChatGPT answers "too many requests", the run pauses (2 minutes, doubling to 15) and retries, so nothing is lost. One chat, or a handful, is quick. Run full ChatGPT backups overnight.

## What gets saved

### Claude

One chat (or each chosen chat) is a chat folder, as below, straight in Downloads. A project is a folder named after the project, with `project.json`, `instructions.md`, `docs/`, `files/` and `memory.json` at the top and one chat folder per chat. *Back up all chats* writes:

```
Claude Backup/
  _index.md / _index.json       every chat with counts per category (full runs)
  _conversations.json           the chat list as Claude returned it
  _status.json                  live progress and recent log (rewritten every ~15 s)
  _projects/<name>/             project.json, instructions.md, docs/, files/, memory.json, syncs.json
  _account/memory.json          what Claude remembers across chats (full runs)
  _account-files/               account files no chat folder already has
  2026-05-21 Chat title [a1b2c3d4]/
    conversation.json           raw API payload: every branch, thinking, tool calls
    transcript.md               main branch with thinking and pasted text inline
    branches.md                 edited and retried branches, when any
    thinking.md                 every thinking block
    pasted/                     pasted text and text attachments
    uploads/                    your files, original bytes
    outputs/                    files Claude made (sandbox outputs; text rebuilt from the chat if expired)
    tool-images/                images returned inside tool results
    created-files/              other files Claude created, rebuilt from the chat
    file-versions/              earlier versions of rewritten files
    artifacts/                  final version of each artifact
    project/                    the chat's project (single-chat and chosen-chat backups)
    manifest.json               every file, how it was fetched, and anything that failed
```

Incognito (temporary) chats never appear in Claude's lists. Recent ones can still be fetched by ID: paste their links into **Only these chats** on the backup page. Claude purges older ones.

### ChatGPT

As for Claude: a chat folder (or a project folder) straight in Downloads, or for *Back up all chats*:

```
ChatGPT Backup/
  _index.md / _index.json        every chat with counts (full runs)
  _conversations.json            the chat list as ChatGPT returned it
  _status.json                   live progress and recent log
  _account/                      memories, custom instructions, settings, shared links (full runs)
  _image-library/                generated images not already saved with a chat (full runs)
  _projects/<name>/              project settings, instructions and knowledge files
  2026-11-05 Chat title [6aec4e53]/
    conversation.json            raw API payload: every branch, hidden and tool messages
    transcript.md                main thread with thinking, tool calls and outputs
    chatgpt-view.md              what ChatGPT shows
    branches.md                  edited and regenerated branches, when any
    thinking.md                  every reasoning summary
    uploads/                     your files (including voice dictation), checked against ChatGPT's recorded size
    outputs/                     generated images, charts, Code Interpreter files
    files/                       files listed for the chat but not linked from a message
    canvas/                      final canvas documents
    project/                     the chat's project (single-chat and chosen-chat backups)
    manifest.json                every file, how it was fetched, and anything that failed
```

Expected failures, recorded in `manifest.json`: Code Interpreter sandbox files expire after about 7 days, old voice-mode audio and some old uploads are gone from ChatGPT's servers, and `.js` sandbox files can't be downloaded.

## How it works

- The backup page is an extension tab, so a long run doesn't depend on the service worker staying awake.
- Requests run inside a background claude.ai or chatgpt.com tab, with the same session as the site. ChatGPT's bearer token is read from its own session endpoint and never leaves that tab.
- Files are written with `chrome.downloads` straight into Downloads (or `Downloads/<folder>/` for full runs), with no ZIP and no save dialogs.
- Full runs remember finished chats per folder in `chrome.storage`, so an interrupted run resumes where it stopped.
- Timers run in a worker, so a hidden tab isn't throttled to one tick a minute.
- If claude.ai shows a Cloudflare "Just a moment…" check, the run reloads its tab and waits. If the check needs a click, open the background claude.ai tab and complete it.

## Using the official data export as a map

Each site's official export (Settings → Data controls / Privacy → Export) lists every chat and file, but the live API holds richer data. Use both:

**Claude**

```bash
python3 -I scripts/claude/hints-from-official-export.py "<unzipped export>"   # writes claude/archive-hints.json (git-ignored)
# Reload the extension, run Back up all chats: it also tries every chat, file and project the export knows
python3 -I scripts/claude/merge-official-export.py "$HOME/Downloads/Claude Backup" "<unzipped export>"
```

The merge adds `_official-export-only/` (chats Claude no longer serves), `_official-export/` (memories, design chats, published artifacts, Claude Code cloud) and `_coverage.md`.

**ChatGPT**

```bash
python3 -I scripts/chatgpt/merge-official-export.py "$HOME/Downloads/ChatGPT Backup" <export.zip>   # _library, _codex, recovered files, _coverage.md
python3 -I scripts/chatgpt/verify-archive.py "$HOME/Downloads/ChatGPT Backup"                      # independent completeness check
node scripts/chatgpt/rerender.mjs "$HOME/Downloads/ChatGPT Backup" [--write]                        # rebuild transcripts offline after a renderer fix
python3 -I scripts/chatgpt/seed-from-archive.py "<archive folder>"   # carry finished-chat state to another computer (chatgpt/archive-state.json)
```

## Driving it from a script

Put a random `automation-token.txt` (16+ characters, git-ignored) in the extension folder and reload the extension. Opening these links in Chrome then runs commands. The token stops web pages from triggering anything.

```bash
T=$(cat automation-token.txt)
open -g "https://claude.ai/#ccb=$T&cmd=reload"                                        # reload the extension
open -g "https://claude.ai/#ccb=$T&cmd=archive"                                       # all Claude chats
open -g "https://claude.ai/#ccb=$T&cmd=archive&uuids=<id>,<id>&root=Test&force=1"     # chosen Claude chats
open -g "https://claude.ai/#ccb=$T&cmd=archive&project=<project uuid>"                # one Claude project
open -g "https://chatgpt.com/#ccb=$T&cmd=archive&ids=<id>,<id>&root=Test&force=1"     # chosen ChatGPT chats
open -g "https://chatgpt.com/#ccb=$T&cmd=archive&project=g-p-<id>"                    # one ChatGPT project
```

Without `root=`, chosen chats and projects go straight into Downloads and write no `_status.json`. Give `root=` to keep the old behaviour (a folder, `_status.json`, resume). The archiver is picked from the site the link opens on (or `site=claude|chatgpt`). More options: `extra=` (unlisted Claude chats), `redo=` (re-archive chosen ChatGPT chats), `probe=path|path` (save raw API responses to `_probe/`), and `account=1` (ChatGPT account data only). The older `#ceh=` and `#cga=` prefixes still work. Watch `Downloads/<root>/_status.json` for progress.

## Older tools

Both earlier extensions' quick tools are still in the popup's footer link:

- **Claude: ZIP export.** This chat, pick chats or all chats, as a ZIP of `chat.md`, artifacts, pasted text and visible thinking, plus combined/deduplicated text files. There is also a floating button on claude.ai chat pages.
- **ChatGPT: Attachments & transcript.** Scan the open chat's attachments, download them one by one (verified sizes, retry and resume), and save the transcript as Markdown or JSON. Details: [docs/chatgpt/README-chatgpt-attachment-downloader.md](docs/chatgpt/README-chatgpt-attachment-downloader.md), [SECURITY](docs/chatgpt/SECURITY.md), [PRIVACY](docs/chatgpt/PRIVACY.md).

## Privacy

- All processing is local. The extension only talks to claude.ai and chatgpt.com (and the file-storage hosts they hand out), using your browser session.
- No analytics, no remote code, no third-party servers.
- ChatGPT credentials stay in the chatgpt.com page's memory and are never stored.

## Limitations

- Both sites change their web apps and internal APIs without notice, so the extension needs updates from time to time. The raw `conversation.json` is always kept, so transcripts can be rebuilt later.
- Hidden reasoning can't be recovered. On both sites, most thinking is stored as summaries only.
- Not affiliated with or endorsed by Anthropic or OpenAI.

## Develop

```
manifest.json, background.js, automation.js   one extension; the worker loads both halves
popup/                                       the backup popup
claude/                                      Claude half (plain files, no build)
src/chatgpt/  →  chatgpt/                    ChatGPT half: readable source → built bundles (npm run build)
scripts/claude, scripts/chatgpt              official-export, verify and rerender tools
test/claude, test/chatgpt                    unit, integration and browser tests
```

```bash
npm install
npm run build     # after editing src/chatgpt
npm run check     # manifest, referenced files, syntax, versions, page rules
npm test          # Claude + ChatGPT unit/integration tests
CAD_CHROMIUM_EXECUTABLE=<Chromium> npm run test:chatgpt:browser   # real-Chromium fixture for the attachments tool
```

Branded Chrome 137+ ignores `--load-extension`. For browser tests, use Playwright's Chromium or Chrome for Testing.

## Acknowledgements and license

[MIT License](LICENSE). See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) (claude-artifacts-downloader, claudesave) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (pionxzh/chatgpt-exporter).
