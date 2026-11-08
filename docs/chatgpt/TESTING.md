# Verification report — 1.1.0, 2026-10-28

## Summary

| Layer | Status |
| --- | --- |
| Static checks (`npm run check`) | Passed |
| Unit and separate-realm messaging tests (`npm test`) | **61 passed**, 0 failed, 0 skipped |
| Real Chromium with the unpacked extension loaded (`npm run test:browser`) | **Passed** (Playwright Chromium 151) |
| Live signed-in ChatGPT: attachment downloads (1.0.1) | **Confirmed working** by the user on 2026-10-28 |
| Live signed-in ChatGPT: transcript export (1.1.0) | Not yet run live (see “Still to verify”) |

## Transcript export (1.1.0)

`tests/transcript.test.mjs` covers the renderer on two real-structure conversations from chatgpt-exporter’s own test fixtures (`tests/fixtures/`):
- Reasoning, `reasoning_recap`, and tool calls to `web.run` / `internal_tool` are omitted, and question/answer order is kept.
- Generated images link to downloaded filenames.
- Hidden tool text is skipped.

A synthetic conversation covers:
- the `current_node` branch only, so an abandoned branch is excluded;
- system messages, custom instructions, tool calls and raw tool output are left out;
- private-use citation markers become links, and a Sources list is added;
- attachment links are escaped;
- code containing triple backticks gets a longer fence;
- continuation replies merge into one ChatGPT turn.

Controller tests cover:
- Save Markdown or JSON without a scan; JSON equals the API response;
- the transcript is saved last on Download all, linked to the saved names;
- a transcript-only run when everything was already downloaded;
- 404, HTML, and non-conversation responses fail only the transcript;
- Stop.

The Chromium fixture adds:
- a real Download all run that saves the transcript last;
- the transcript links to `direct.pdf`;
- the popup’s **Save JSON** button.

## Real Chromium fixture (`tests/browser.mjs`)

The built `extension/` folder is loaded into a fresh Chromium profile. Branded Google Chrome 137+ ignores `--load-extension`, so Playwright’s Chromium is used. `chatgpt.com` is answered by Playwright routes. `files.oaiusercontent.com` is served by a **real local TLS server** behind a proxy that refuses every other host. That setup is needed because Playwright routes skip CORS checks and are not applied to redirect targets. The test reaches nothing on the internet.

What it drives and asserts:

- The manifest loads, and authentication is captured from a page fetch at `document_start`.
- The real popup scans and shows 12 attachments, the type chips, and light and dark themes.
- Clicking **Download all** dismisses the multiple-downloads notice. The popup is then closed, and the batch finishes without it.
- 10 files download with byte-exact contents and the expected names. 2 are refused, and nothing is saved for them:
  - direct PDF bytes;
  - a two-stage metadata link to the storage host (saved under the metadata name, size verified);
  - legitimate JSON and JSONL;
  - duplicate names (`same.txt` twice), which produce two separate files;
  - `session-notes.txt`, which keeps its real name;
  - **an HTTP 302 from the ChatGPT download route to storage**, which is followed;
  - **a storage host without CORS headers.** The page fetch genuinely fails, and the forced-attachment link is handed to Chrome. It is marked as delivered by link.
  - **a genuine `report.html`** whose size matches the metadata;
  - *refused:* the ChatGPT HTML shell served for `bad.pdf` (`HTML_RESPONSE`);
  - *refused:* a JSON `{"detail": …}` error served for `data.csv` (`SERVER_ERROR`).
- **Header scoping on real network requests.** No request to the storage host carried `authorization`, `oai-device-id`, `cookie` or `referer`, including the redirected hop and the Chrome-handled link.
- Per-file failures show on their rows and leave the batch banner empty.
- A deliberate redownload hits a 429 with `Retry-After: 30`, and Stop works during the backoff.
- SPA `pushState` to another conversation clears the list. A full reload resets auth and the scan, and a rescan restores saved successes.
- `chrome.storage.local` contains no synthetic token, device ID, signed link, `Bearer`, `authorization`, or `download_url`.
- No page errors.

Screenshots are saved to `test-results/` (`popup-light.png`, `popup-dark.png`, `popup-completed.png`).

## Redirect header experiment (Chromium 151)

This ran separately from the fixture, using a local TLS stand-in for the storage host.

| How a ChatGPT 302 to storage was followed | What the storage host received |
| --- | --- |
| Extension’s method: bearer header only, `credentials: same-origin` | No Authorization, no `oai-device-id`, no cookie. Download succeeded. |
| Manual script’s method: all headers, auto-follow | Authorization stripped, but **`oai-device-id` forwarded**. The request then failed CORS. |

A later fixture run showed that Chrome also forwards an origin-only Referer on the redirected hop. The follow request therefore now sets `referrerPolicy: no-referrer`.

## Unit and messaging tests (`npm test`)

These cover:

- direct bytes;
- metadata → file;
- four hops allowed, a fifth rejected;
- HTML variants (MIME type, prefix, BOM, case, comment) and the size-matched `.html` exception;
- JSON/JSONL byte equality, including JSON that contains `download_url`;
- JSON error envelopes;
- zero-byte responses and their metadata exception;
- magic-byte checks: text posing as PDF/PNG fails, other binary passes;
- size mismatch, with a single retry;
- list sizes are not used to fail files;
- filename sanitizing, which keeps “session/token/cookie/email” names;
- duplicates, and long multibyte names;
- 429 with `Retry-After` and fallback delays;
- 401, 403 and 404 handling, including that storage and post-redirect 401s do not expire auth;
- bounded 5xx and network retries;
- stop during fetch, backoff, or the inter-file delay;
- stall timeout, plus steady slow transfers that are not timed out;
- byte-progress streaming and throttled progress publishing;
- link fallback, used only for forced-attachment links;
- token refresh, a late 401, and readiness announced once across 25 requests;
- coexisting fetch wrappers;
- one wrapper after reinjection;
- the MAIN → content → worker → popup bridge in separate VM realms;
- popup closure;
- SPA navigation;
- history restore;
- sanitized events, storage and diagnostics;
- list-shape diagnostics, which record keys and types only.

## Still to verify on the live site

This needs a signed-in ChatGPT tab.

Attachment downloads have been confirmed on the live site. For the transcript:

0. Click **Save Markdown** on a long conversation with web citations, code and uploads. Check that:
   - the messages match the visible chat;
   - citations read as links;
   - the 📎 links open the downloaded files when the `.md` sits in the same folder.

   Click **Save JSON** and confirm the file opens.

For a fresh install, the attachment smoke test is:

1. Load `extension/` at `chrome://extensions`, then reload a ChatGPT conversation. The popup should show **Auth ready**.
2. **Scan.** Compare the count and names with the conversation’s attachments.
   - If it shows “ChatGPT’s attachment API may have changed”, open Details → **Export diagnostics** and look at `listResponseShape`.
3. **Download a few files, including a PDF.** Open the PDF.
   - Rows reading **Sent to Chrome · Not verified** mean the storage host refused page fetches. Check those files in `chrome://downloads`.
4. **Batch and close the popup.** Start a multi-file batch, allow Chrome’s multiple-downloads prompt, and close and reopen the popup. Then Stop, Resume, and navigate to another chat.

Never paste tokens, raw headers, or signed links into reports. The diagnostics export contains none of them.
