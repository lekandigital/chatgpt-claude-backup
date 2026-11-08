# ChatGPT Attachment Downloader

A personal, unpacked Chrome extension for downloading the attachments and the transcript of **the ChatGPT conversation you currently have open**. It scans on demand and downloads one file at a time, with a 1.5-second pause between files. Version 1.1.0 (see `CHANGELOG.md`). Not affiliated with or endorsed by OpenAI.

## Install from GitHub

```sh
git clone https://github.com/lekandigital/chatgpt-attachment-downloader.git
```

Then load the `extension` folder as described below. No build step is needed: `extension/` is committed ready to load.

## Install — no coding or build step needed

1. Clone the repository (or extract a ZIP of it). Keep the folder somewhere permanent; Chrome loads the extension from that folder.
2. In Chrome, enter `chrome://extensions` in the address bar.
3. Turn on **Developer mode** at the upper right.
4. Click **Load unpacked**.
5. Select the **`extension` folder inside `chatgpt-attachment-downloader`**. This is the folder containing `manifest.json`, `main-world.js`, and `popup`.
6. Pin **ChatGPT Attachment Downloader** using Chrome’s puzzle-piece menu if you want easy access.
7. **Reload any ChatGPT tab that was open before installation.** The extension needs to observe a normal authenticated page request. No DevTools or token copying is needed.

Chrome 111 or newer is required. Only `https://chatgpt.com/*` is supported. Chrome Web Store publication is not required. To remove the extension, click **Remove** on its card in `chrome://extensions`.

## Use

1. Open a conversation at `https://chatgpt.com/c/...` (project and custom-GPT conversation paths containing `/c/` also work).
2. Click the extension. Wait for **Auth ready**.
3. Click **Scan attachments** and review the list.
4. Click **Download all**, or check specific files and click **Download selected**. (Starting the first batch dismisses the one-time notice about Chrome’s multiple-downloads prompt.)
5. Use the search box and the **All / PDF / Images / Documents / Text / Other** chips to narrow the list; **Export file list** in Details saves a CSV of names, IDs, sizes and statuses.
6. If Chrome asks whether ChatGPT may download multiple files, choose **Allow**.

Downloads use your Chrome download folder and settings. They are separate original files, not one combined ZIP. Closing the popup does not stop the batch. **Keep the ChatGPT tab open and on the same conversation.** A sleeping or discarded tab may interrupt processing.

**“Downloaded” means validated bytes were handed to Chrome.** A row marked **Sent to Chrome · Not verified** is the one exception: the storage host refused a page fetch, so Chrome was given the signed link directly and the bytes could not be checked (see Download safeguards). Because this version uses page-created Blob links rather than the Downloads API, it cannot confirm disk completion, identify browser-blocked downloads, or detect a canceled Save dialog. Check Chrome’s Downloads (`chrome://downloads`). If a file was blocked or canceled, explicitly select it and use **Download selected again**.

## Full archive (every chat)

**Full archive** at the bottom of the popup opens a page that saves every chat in your account, each in its own folder under `Downloads/ChatGPT Full Archive/` — no ZIP, no save dialogs:

```
ChatGPT Full Archive/
  _index.md / _index.json        every chat with counts (written at the end)
  _conversations.json            the chat list as the API returned it
  _status.json                   live progress and recent log (rewritten every ~15 s)
  _account/                      memories, custom instructions, settings, shared links
  _image-library/                generated images not already saved with a chat
  _projects/<name>/              project settings, instructions and files
  2026-11-05 Chat title [6aec4e53]/
    conversation.json            raw API payload: every branch, hidden and tool messages
    transcript.md                main thread with thinking, tool calls (in full) and outputs (shortened)
    chatgpt-view.md              what ChatGPT shows (the single-chat transcript format)
    branches.md                  edited/regenerated branches, when any
    thinking.md                  every reasoning summary
    uploads/                     your files, verified against ChatGPT's recorded size
    outputs/                     generated images, charts and Code Interpreter files
    files/                       files listed for the chat but not linked from a message
    canvas/                      final canvas documents
    manifest.json                every file, how it was fetched, and anything that failed
```

Requests run inside a background chatgpt.com tab through `archive-page.js`, which reuses the attachment downloader's transfer client (retries, 429 handling, safe redirects) and its metadata-hop, size and magic checks. It reads the bearer token from ChatGPT's own session endpoint, and the token never leaves that page. Chats are processed newest first, and finished chats are remembered per folder, so a rerun only redoes new or changed ones.

ChatGPT rate-limits conversation reads (a burst of roughly 200, then a slow refill). When it answers 429 the whole run pauses — 2 minutes, doubling to 15 — and retries the same request, so a large account can take many hours but nothing is marked failed for rate limits. Expired Code Interpreter sandboxes (`sandbox:/mnt/data/…` links) are the expected failures; files ChatGPT also registered for the chat are saved from its file list instead.

Optional automation: put a random `automation-token.txt` (16+ characters, git-ignored) in the `extension/` folder and reload; then `https://chatgpt.com/#cga=<token>&cmd=archive` (optionally `&ids=<id>,<id>&root=Test&force=1`) starts a run and `&cmd=reload` reloads the extension. Watch `_status.json` for progress.

## Chat transcript

The **Transcript** box in the popup saves the open conversation itself. It needs no scan.

- **Save Markdown** writes `<conversation title> (transcript).md`. It contains the title, a link back to the chat, the created/updated times and the model, then every visible message under `### You` and `### ChatGPT` headings with UTC timestamps.
  - Web citations become inline links, and each reply ends with a **Sources** list.
  - Code is fenced.
  - Files you uploaded are listed under the message with a 📎.
  - Images appear where ChatGPT showed them.
  - Attachments and images that were already downloaded are **linked by their saved filename**, so the transcript works when it sits in the same folder as the files.
- **Save JSON** writes the conversation exactly as ChatGPT’s API returned it: every branch and all metadata, for archiving or other tools.
- **Include the Markdown transcript with Download all** is on by default and remembered. When a Download all finishes, the transcript is saved last, so its links match the files just saved. If every attachment was already downloaded, Download all saves only the transcript. Stop cancels it, and a transcript failure never fails the attachment batch.

The Markdown follows what ChatGPT shows you. It **leaves out**:
- other branches: earlier versions of regenerated or edited messages you moved away from;
- system messages;
- your custom instructions and saved memories;
- the model’s hidden reasoning;
- tool calls and raw tool output (for example web.run results);
- messages ChatGPT marks hidden.

Use JSON when you want everything. Which messages are shown, and how citations are resolved, follow [pionxzh/chatgpt-exporter](https://github.com/pionxzh/chatgpt-exporter), the actively maintained userscript (v2.38.0, Oct 2026), which uses the same `/backend-api/conversation/{id}` route. The transcript request reuses the extension’s page-memory authentication, retries, 429 handling and Stop, exactly like attachment downloads.

## Stop, resume, and retry

- **Stop** immediately aborts the current network request or retry wait. Already handed-off files remain completed; unstarted files stay pending. It cannot cancel a file Chrome has already accepted.
- **Resume** processes pending, stopped, and failed files, skipping completed files.
- **Retry failed** processes failed files only.
- Selecting a completed file explicitly allows another download, with a distinct filename.
- Search filters filenames. Selection actions apply to visible rows; **Select none** clears all selections. **Hide completed** only hides rows and retains their completion history.

Navigating to another conversation stops the current batch, clears the visible list, and requires a fresh scan. After a full reload, scan again: locally saved successes for that conversation are restored and skipped. Credentials are never restored from storage. Saved progress covers the eight most recently scanned conversations, up to 5,000 records each; running a batch on one tab at a time is recommended.

## What is included

| Path | Purpose |
| --- | --- |
| `extension/` | Built extension, ready for Load unpacked |
| `extension/manifest.json` | Manifest V3, version 1.0.1 |
| `src/` | Readable source modules, manifest source, and popup HTML/CSS |
| `scripts/` | Dependency-free build, local icon generation, static checks |
| `tests/` | Unit tests, separate-realm messaging tests, and Chromium fixture test |
| `PRIVACY.md` | Privacy policy |
| `CHANGELOG.md` | What changed between versions |
| `THIRD_PARTY_NOTICES.md` | MIT notice for the adapted chatgpt-exporter logic and test fixtures |
| `SECURITY.md` | Trust boundaries and credential handling |
| `TESTING.md` | Verification results and remaining manual checks |

## Architecture and private authentication

The MAIN-world script installs at `document_start` and passively observes the page’s existing authenticated `fetch` calls to ChatGPT’s `/backend-api/` routes. It does not call a login endpoint or ask you for a credential. It keeps a narrow allowlist of reusable headers **only in a private JavaScript closure inside the page**. Fresh observed requests replace the in-memory context; unloading the page clears it.

The wrapper delegates to the fetch implementation already installed, preserving its receiver, arguments, promise identity, and exceptions. It does not read request bodies, mutate page requests, or replace other extensions’ wrappers with a stale native reference.

Authenticated listing, link resolution, byte fetching, validation, and Blob saving all happen in MAIN. The isolated content script accepts only fixed commands and projects the resulting state into an explicit schema. The worker validates senders, routes commands, and stores sanitized file progress. The popup displays that state and owns no running job. Closing the popup or suspending the extension worker does not end the page’s work.

The only permissions are **storage**, **activeTab**, and the **ChatGPT host permission**. There is no cookies, history, tabs, scripting, webRequest, downloads, or all-sites permission. Declarative MAIN/isolated scripts avoid a scripting permission. `activeTab` identifies the tab you invoke the popup on; the ChatGPT host permission supports injection and routing only on ChatGPT pages.

**The extension does not send analytics. It does not upload conversation data. Authentication credentials are kept only in volatile page memory. Credentials are never persisted in extension storage.** There are no runtime dependencies, remote scripts, external fonts, CDN assets, telemetry, or developer servers. It sends requests only to ChatGPT and recognized file-storage URLs returned by ChatGPT. See `SECURITY.md` for the MAIN-world trust boundary: page scripts can interfere with a MAIN-world controller, so this is not isolation from a compromised ChatGPT page or a malicious extension.

## Download safeguards

- The initial response may be bytes or metadata containing `download_url`. Only metadata with a usable URL is followed, for at most four hops. The metadata itself is never saved as the attachment.
- Ordinary JSON/JSONL without `download_url` is preserved exactly. Bytes whose length matches the `file_size_bytes` ChatGPT announced are always treated as the file, so even a JSON attachment that itself contains a `download_url` key downloads correctly.
- HTML is rejected by MIME type and by document prefix (`<!DOCTYPE html`, `<html`, with BOM/comments/case variations). The one exception is an attachment named `.html`/`.htm` whose bytes exactly match the size ChatGPT announced for it, because an app-shell page returned in place of a file cannot satisfy that.
- A JSON error envelope (`detail`, `error`, or `status: "error"`) served in place of a non-JSON attachment fails as “ChatGPT returned an error message instead of the file” rather than being saved as `data.csv`.
- A zero-byte response is rejected unless ChatGPT’s metadata says the file is empty. PDF, PNG, JPEG and Office/ZIP signatures get an extra check that fails text (JSON, HTML, an error message) posing as those formats; other binary content is still saved.
- Size is verified against the metadata `file_size_bytes`. A mismatch retries from stage 1 once, then fails without saving. Sizes from the attachment list are shown but not used to fail files. “Verified” means size matched, not a checksum or malware scan.
- Filenames are made filesystem-safe: path characters, control and bidi characters, and reserved device names are removed; missing names get a `chatgpt-file-N-<id>` fallback; `undefined`/`null` are never used. Names are **not** keyword-redacted — `session-notes.txt` stays `session-notes.txt`. Batch duplicates get ` (2)` suffixes; Chrome handles name clashes with files already on disk.
- Credentials and custom account headers are attached only to same-origin ChatGPT backend requests. External storage receives no captured headers, cookies, or referrer.
- ChatGPT requests use `redirect: manual`. If ChatGPT answers with an HTTP redirect, it is followed once with **only** the bearer header and no referrer; the browser drops that header when the redirect leaves chatgpt.com, and the final destination must pass the same host allowlist. This was verified in Chromium 151: the storage host received no Authorization, device ID, cookie or referrer. (Auto-following with all headers, as the manual console script did, forwards `oai-device-id` to the storage host.)
- External destinations are restricted to `*.oaiusercontent.com` and recognized `sdmntpr*` / `oaisdmntpr*` Azure or S3 delivery hosts. Unknown hosts fail safely. This allowlist is in `src/core/endpoints.js`.
- If an allowlisted storage host refuses the page’s fetch (CORS), and the signed link forces `Content-Disposition: attachment` (`rscd=attachment…` or `response-content-disposition=attachment…`), the link is handed to Chrome inside the page — the same fallback the manual script used. The row shows **Sent to Chrome · Not verified**. Without that forced-attachment marker the file fails instead, so a viewable response can never navigate the ChatGPT tab away.
- Requests are sequential. There are four rate-limit retries, three server-error retries, and two network retries per request, with abortable waits. A request times out only after 90 seconds with no bytes arriving, so large files are not cut off; the popup shows bytes received for the active file.
- `Retry-After` seconds or dates are honored, otherwise the delay increases through 30, 60, 90, and 120 seconds. There is no background polling of ChatGPT endpoints. The popup’s status polling is local message passing only.
- A 401 from ChatGPT pauses the batch. It resumes only when you click Resume after a fresh page credential is observed. A 401/403 from a storage host, a 403, or a 404 fails that file while allowing other files to proceed.

## Pagination and internal API changes

This version implements the internal routes supplied in the build specification:

```text
/backend-api/conversations/{conversationId}/files?limit=200
/backend-api/files/download/{fileId}?check_context_scopes_for_conversation_id={conversationId}&download_intent=true
/backend-api/conversation/{conversationId}            (transcript)
```

It recursively extracts `file_id` or `id` values beginning with `file_` (also tolerating `file-`) and associated filename, size, and MIME metadata. It preserves response order and deduplicates by file ID.

Recognized `next_cursor` and `next_offset` envelopes are followed. Repeated cursors and repeated pages stop safely. Unknown continuation schemas, a full 200-record page without a completion signal, or the 50-page/5,000-file cap produce a visible partial-list warning. It does not guess arbitrary next URLs or claim a partial list is complete.

**These routes are internal implementation details, not a supported public OpenAI API. They can change.** Route construction and pagination parsing are centralized in `src/core/endpoints.js`; extraction is in `src/core/files.js`. This extension handles files returned by that list endpoint. It does not crawl the account or scrape every conversation, and it cannot recover expired or unauthorized files.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Auth waiting / reload to connect | Reload the ChatGPT tab once after installation; let the conversation finish loading. The page must use an authenticated fetch request the observer can see. |
| Authentication expired / 401 | Wait for a normal fresh ChatGPT request and then Resume. Or reload, scan again, and Resume. Do not copy tokens. |
| Rate limited / 429 | Leave the tab open for the displayed backoff, or Stop. After retry exhaustion, retry later. Do not repeatedly reload or click retry. |
| No attachments found | Confirm you are on the intended conversation. The API may not expose every generated artifact or sandbox link. An empty list is not an error. |
| Progress says downloaded, but files are missing | Check Chrome’s Downloads and site permission for automatic/multiple downloads. Select blocked files explicitly to download again. |
| A Save dialog appears for every file | Chrome’s “Ask where to save each file” setting applies to this extension too. |
| HTML response / API changed | The route may now return a login page or app shell, or the list schema changed. Nothing is saved under a false filename. |
| Network/CORS/page policy error | The browser may block the returned storage host or request. Forced-attachment storage links fall back to a Chrome download automatically; others fail. This extension does not weaken CSP, use a proxy, or add broad host permissions. |
| Sent to Chrome · Not verified | The storage host refused a page fetch, so Chrome downloaded the signed link itself. Check the file in Chrome’s Downloads. |
| ChatGPT returned an error message instead of the file | The download route returned a JSON error (expired or deleted file, permission change). Nothing was saved. Retry later. |
| Unsupported destination | ChatGPT may be using a new storage host; inspect and update the centralized allowlist before rebuilding. |
| Size mismatch | The file was not saved after its one integrity retry. Retry later or download it manually in ChatGPT. |
| Request timed out | No bytes arrived for 90 seconds. Retry the file. On a very slow link, raise `STALL_TIMEOUT_MS` in `src/core/config.js` and rebuild. |
| Another extension is installed | Existing fetch/history wrappers are preserved. Unrelated ad-blocker telemetry errors are ignored. No need to disable other extensions without evidence they block attachment requests. |
| API schema changed | Export diagnostics: `listResponseShape` lists the key names and value types (never values) of the attachment-list response, which shows how the schema moved. Update `endpoints.js` / `files.js` and rebuild. Never paste credentials into an issue. |

## Develop and verify

Node.js 20+ is needed only to edit/build/test the source. No installation is needed for the normal build or unit tests:

```sh
npm run build
npm run check
npm test
```

The build concatenates named closure modules into four isolated bundles. It contains no dynamic code generation, eval, package fetch, or runtime imports. Icon PNGs are generated from local geometry. Reload the extension’s card in `chrome://extensions` and reload ChatGPT after rebuilding.

For the optional real-browser fixture test (needs `openssl` on the PATH):

```sh
npm install
npx playwright install chromium
npm run build
npm run test:browser
```

Branded Google Chrome 137+ ignores `--load-extension`, so the test uses Playwright’s Chromium. It uses a fresh temporary profile and synthetic credentials. ChatGPT is answered by Playwright routes; the storage host is a local TLS server behind a proxy that refuses every other host, so real CORS and redirect behavior is exercised without touching the network. It never uses your signed-in Chrome profile. Consult `TESTING.md` for which checks were actually executed in this delivery.

Relevant primary documentation: [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [manifest execution worlds](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts), [Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [Playwright extension tests](https://playwright.dev/docs/chrome-extensions).
