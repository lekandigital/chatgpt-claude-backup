# Security and trust boundaries

## Credential lifecycle

`Authentication.create()` in `src/core/auth.js` is instantiated only inside the MAIN bundle’s private IIFE. It copies only a narrow set of reusable authentication/account headers from the most recent same-origin backend fetch. RequestInit header overrides use the browser’s replacement semantics. Body content is never read or cloned.

Content type/length, trace IDs, baggage, request IDs, cookies, and one-time request proof headers are not replayed. The current allowlist is explicit, not a blacklist. If an endpoint later requires a new header, it must be added deliberately after understanding its purpose.

The popup, content script, and worker never receive a captured Headers object. Authentication readiness is a boolean; the token is not sent through postMessage, Chrome messaging, storage, log strings, export files, filenames, or URLs. The only outgoing use of the captured credential is the intended HTTPS request to the ChatGPT backend.

401 invalidation is versioned, so an older in-flight request cannot erase a newly observed credential. Downloader-initiated fetches delegate to the pre-installation fetch implementation and are not themselves observed as fresh page authentication.

## Network scope

Only current-conversation list and current-scan file IDs are accepted. Selected IDs must exist in the fresh scan. All requests use GET. There is no arbitrary URL, arbitrary code, proxy, cross-account, cookie-export, or whole-account crawling interface.

Signed metadata URLs are parsed inside MAIN, validated against HTTPS, credential-free URLs, same-origin backend paths or recognized file-storage hosts, then fetched with origin-appropriate headers. External requests use empty captured headers, `credentials: omit`, and `referrerPolicy: no-referrer`.

ChatGPT requests use `redirect: manual`, so an HTTP redirect is detected without forwarding anything. It is then followed once with a request carrying **only** the bearer header, `credentials: same-origin` and `referrerPolicy: no-referrer`; the Fetch standard requires browsers to drop Authorization when a redirect changes origin, and the final `response.url` must pass the same allowlist (otherwise the body is discarded unread). This was checked in Chromium 151 against a local TLS stand-in for the storage host: the redirected request carried no Authorization, `oai-device-id`, cookie or referrer. The same experiment confirmed why custom headers are never auto-followed: with the full header set, Chrome removed Authorization but forwarded `oai-device-id` to the storage host. A 401 after such a redirect, or from a storage host, fails only that file and never invalidates the page credential.

Storage requests use `redirect: follow` (they carry no captured headers or cookies), and their final URL is checked the same way. Metadata URL hops are followed explicitly and capped at four. Unknown hosts fail closed.

If an allowlisted storage host refuses the page fetch (CORS) and its signed link forces `Content-Disposition: attachment`, MAIN clicks an anchor to that link (`rel="noopener noreferrer"`) so Chrome downloads it without page CORS. The link never leaves MAIN; the file is recorded as delivered by link and unverified. Links without the forced-attachment parameter are never clicked, because a viewable response could navigate the ChatGPT tab away.

The page’s CSP and CORS apply to MAIN fetches. The extension does not bypass them; the link fallback above is an ordinary browser download. No broad host permissions or background-fetch fallback are used.

## Message boundaries

The MAIN/content bridge checks event source, exact origin, namespace, request ID shape, command allowlist, conversation ID, and file ID shape. The content script and worker independently reconstruct state from explicit allowed fields; raw API objects and exceptions are never forwarded. Error strings are fixed local messages. Diagnostic exports further omit identifiers and filenames.

`window.postMessage` is **not a secret or authenticated channel**. The host page can see and forge same-window messages, including status data and the narrow commands. A MAIN-world script cannot provide cryptographic isolation from the page it runs inside. Namespace and random request IDs prevent accidents and correlate requests; they are not authentication. Command scope is limited to the open conversation and freshly scanned files. RESTORE_HISTORY only supplies prior statuses and cannot add downloadable IDs to a scan.

The isolated bridge does not turn page messages into arbitrary privileged extension calls. Only reconstructed progress is persisted. The worker accepts control commands only from its own popup URL, and state/history messages only from its own top-frame ChatGPT content script. No external-connectable or web-accessible resources are declared. The extension does not use a privileged Downloads API.

Other extensions that already intercept page fetches can see the requests they already wrap. This extension cannot protect against a malicious extension, compromised ChatGPT code, injected page scripts, a hostile browser, or an OS-level attacker. Do not interpret “kept in a closure” as isolation from those threats.

## Transcripts

The transcript request (`GET /backend-api/conversation/{id}` for the open conversation only) runs in MAIN through the same request client as attachments. It uses the same captured headers, retries, and abortable waits. The conversation JSON is parsed and rendered in MAIN and saved through the same Blob anchor. Neither the content nor the response ever crosses the bridge or reaches extension storage. Only the transcript’s status, format, message count, timestamp and error category are reported. An HTML or non-conversation response fails the transcript, and nothing is saved.

## Persistence and diagnostics

The worker applies `Safety.state` / `Safety.history` before every write and serializes writes to avoid stale completion regressions. Values are plain JSON records; no Blob, Request, Headers, AbortController, signed link, or credential is stored. Storage is local, not sync. Previous downloaded records are preserved across tabs; current UI state still reflects each live job.

Attachment filenames and conversation titles are the user’s own data: they are made filesystem/display safe (control and bidi characters removed, JWT-shaped strings redacted from titles) but not keyword-redacted, because names such as `session-notes.txt` must download under their real names. The only extension console output is an unexpected error’s name and message passed through `Safety.text`, which removes URLs, JWT shapes and email addresses and replaces anything mentioning bearer/authorization/token/secret/cookie/session/password/api-key with `[redacted]`. Diagnostics contain no filenames or identifiers; `listResponseShape` holds only key names and value types of the list response, filtered to a strict `key:type` pattern.

## Download limits

HTML and empty responses are rejected, except a `.html`/`.htm` attachment or an empty file whose byte count exactly matches the size in ChatGPT’s download metadata. A JSON object with a top-level `download_url` is treated as download metadata unless its length matches that announced size; invalid destinations are rejected rather than saved as a disguised attachment. JSON error envelopes are rejected for non-JSON attachments. Other JSON and JSONL files are unchanged.

Successful status means bytes passed validation and a Blob anchor was clicked. It is not proof of disk completion. Chrome can still block multiple downloads, cancel a prompt, or encounter disk errors. Existing downloads can only be managed in Chrome’s own Downloads UI.

Requests, retry sleeps, and batch delays are abortable. Current-path checks are repeated before requests, after body reads, and synchronously just before save. Both history wrappers and a local pathname watcher handle SPA navigation. The watcher makes no network requests.

Report bugs with the diagnostics export and a description of the failure. Never include tokens, cookies, signed links, or raw request headers.
