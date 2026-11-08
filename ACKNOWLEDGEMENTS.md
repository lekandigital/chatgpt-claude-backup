# Acknowledgements

ChatGPT + Claude Backup combines two of the author's extensions: **Claude Export Hub** (this repository's
earlier name) and **ChatGPT Attachment Downloader** ([lekandigital/chatgpt-attachment-downloader](https://github.com/lekandigital/chatgpt-attachment-downloader)),
whose ChatGPT archiver lives in `src/chatgpt/`. Third-party code notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## claude-artifacts-downloader

This project began as a fork of [ashwanthkumar/claude-artifacts-downloader](https://github.com/ashwanthkumar/claude-artifacts-downloader), an MIT-licensed Chrome extension for downloading Claude artifacts from a conversation.

Claude Export Hub significantly extends that original idea with:

- Multi-chat export (this chat, pick chats, all chats)
- Per-chat folder organization (`chat.md`, `artifacts/`, `pasted/`)
- Transcript export
- Pasted-content export
- Attachment and content-block handling in transcripts
- A redesigned export workflow with progress and cancellation

Portions of the original extension structure and artifact extraction approach are derived from `claude-artifacts-downloader`. The original MIT license and copyright notice are preserved in [LICENSE](LICENSE).

## claudesave

Banner UI patterns were adapted from [hamelsmu/claudesave](https://github.com/hamelsmu/claudesave).
