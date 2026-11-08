# Changelog

## 1.2.0 — 2026-11-05

### Added
- **Full archive** (popup → Full archive): every chat saved as a folder with the raw conversation (all branches), a full transcript with thinking, tool calls and outputs, the ChatGPT view, thinking summaries, uploads, generated files, canvas documents and a manifest; plus memories, custom instructions, settings, shared links, the image library and projects. Resumable, newest chats first, pauses on rate limits instead of failing. New permissions for it: `downloads`, `scripting`, `tabs`, `unlimitedStorage`; extension pages may now read their own package files (`connect-src 'self'`) but still make no network requests.

### Fixed
- **Writing blocks were missing from transcripts.** Drafted documents, emails and Deep Research prompts that ChatGPT shows as writing blocks were deleted together with their citation marker. They are now included, with the email subject when there is one.
- **Inline entities and image carousels lost their text** (for example “Study  and .” instead of “Study Vampire Survivors and Brotato.”).

## 1.1.0 — 2026-10-28

### Added
- **Chat transcript export**, from the popup’s Transcript box:
  - **Save Markdown**: a readable transcript with inline citation links, Sources lists, fenced code, uploaded-file lists, and images. Already-downloaded attachments are linked by their saved filenames.
  - **Save JSON**: the conversation exactly as ChatGPT’s API returned it, with all branches.
  - **Include the Markdown transcript with Download all** (on by default): the transcript is saved after the attachments.
- The request uses `/backend-api/conversation/{id}`, the same route as the actively maintained [chatgpt-exporter](https://github.com/pionxzh/chatgpt-exporter) (v2.38.0). It runs through the existing page-memory auth, retry, 429 and Stop handling. Message selection and citation handling are adapted from that project (MIT, see `THIRD_PARTY_NOTICES.md`).

### Fixed
- **Conversation titles were still keyword-redacted** in the popup (for example “Session planning” showed as “[redacted]”), because the controller sanitized them before display.

## 1.0.1 — 2026-10-28

First version verified with the extension loaded in a real Chromium (see `TESTING.md`), and confirmed working on a live signed-in ChatGPT conversation.

### Fixed
- **Files were renamed** when their name contained “session”, “token”, “secret”, “cookie”, “password”, “api key” or an email address. For example, `session-notes.txt` was saved as `redacted-file.txt`. Names are now only made filesystem-safe. Conversation titles were affected the same way.
- **Files could vanish from a scan** if their ID contained one of those words.
- **Every authenticated ChatGPT request** triggered a status broadcast, a log line, and a storage write. Now only a change in readiness does.
- **Any HTTP redirect failed the download** (`redirect: error`). Redirects are now detected and followed with the bearer header only, and the final host is checked against the allowlist. Chromium 151 was confirmed not to forward Authorization, device ID, cookie or referrer.
- **Large files could time out** under the 120-second total limit. The timeout now fires only after 90 seconds with no bytes arriving.
- **Size checks used the list’s generic `size` field.** Verification now uses only the metadata `file_size_bytes`, as specified.
- **A JSON error returned with HTTP 200** could be saved as a `.txt` or `.csv` attachment. It now fails with “ChatGPT returned an error message instead of the file”.
- **A 401 from a storage host** paused the whole batch as “authentication expired”. Now only that file fails.
- **Per-file failures overwrote the batch error banner.**
- **Download buttons stayed disabled** until the multiple-downloads notice was dismissed. Starting a download now acknowledges it.
- **The popup said “Auth waiting”** on non-ChatGPT tabs.

### Added
- When a storage host refuses page fetches (CORS) and its link forces an attachment, the link is handed to Chrome. The row shows “Sent to Chrome · Not verified”.
- Genuine `.html` attachments and genuinely empty files download when their size matches ChatGPT’s metadata.
- Byte progress for the active file.
- File-type filter chips: All / PDF / Images / Documents / Text / Other.
- **Export file list** (CSV).
- `listResponseShape` in diagnostics: key names and types of the list response, with no values.
- The real-browser fixture now uses a local TLS storage host. It covers redirects, real CORS refusal, HTML attachments, JSON errors, and header scoping.

## 1.0.0

Initial build. Unit-tested only; never loaded in a browser.
