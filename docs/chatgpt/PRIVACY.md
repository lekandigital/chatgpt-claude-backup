# Privacy policy — ChatGPT Attachment Downloader 1.1.0

This personal extension is not affiliated with OpenAI. It downloads files the currently signed-in user can already access in the conversation they have opened.

- No user data is sold, shared with the extension developer, or transmitted to a developer-operated server.
- No analytics, advertising, tracking pixels, telemetry, or remote executable code are included.
- The extension’s scripts load on ChatGPT pages to observe authentication in time for user-invoked operations. It does not automatically list files or download attachments. Scanning and downloads start only through a command, normally from the extension popup.
- The extension does not access browser cookies through the cookies API, browser history, other websites, or the user’s other conversations automatically.
- Captured authorization and account headers exist only in volatile page memory. They are used for same-origin ChatGPT backend requests. Credentials are not persisted, shown in the popup, exported, or sent through the extension’s message bridge.
- Signed download links remain in page memory. External file-storage requests omit captured account headers, cookies, and referrers. Only supported storage hosts returned by ChatGPT are contacted. If such a host refuses the page’s request, the signed link may be handed to Chrome’s own downloader inside the page; it is still not stored or shown.
- Transcripts are fetched only when you click **Save Markdown** / **Save JSON**, or when a Download all finishes with “Include the Markdown transcript” checked. The conversation content is processed inside the page and saved straight to your downloads. It is not stored in extension storage or sent anywhere else.
- File bytes stay in the page and Chrome’s download process. They are not stored in extension storage. Temporary Blob URLs are revoked after handoff or when the page unloads.
- Conversation IDs, sanitized file IDs/names, sizes, MIME types, statuses, attempts, timestamps, and error categories are stored in `chrome.storage.local` to support resuming. The last eight scanned conversations are retained, with a cap of 5,000 records per conversation. This is local Chrome profile data, not synchronized extension storage.
- Exported diagnostics contain the extension version, readiness booleans, scan/batch status, file counts, status counts, fixed error categories, and the key names and value types (no values) of the attachment-list response. They omit filenames, conversation IDs, credentials, signed URLs, API response values, account/device IDs, and personal profile data.
- **Export file list** saves a CSV of the current list (filenames, file IDs, sizes, statuses, error categories) only when you click it. It contains no links or credentials.
- **Forget saved history** deletes saved progress. Open tabs can save new progress when their state changes. Uninstalling removes extension storage. Downloaded files remain in the user’s chosen download folder.

MAIN-world code shares the page’s JavaScript environment. It is not a security boundary against a compromised page or malicious browser extension. See `SECURITY.md` for the exact scope of the safeguards.
