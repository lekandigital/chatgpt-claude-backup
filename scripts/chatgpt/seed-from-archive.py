#!/usr/bin/env python3
"""Write chatgpt/archive-state.json from an existing ChatGPT backup folder.

Use it to continue a run on another computer: copy the archive folder there, run this
against it, reload the extension, and start the archive with the same folder name.
Chats whose manifest records a failure the current archiver can fix are left out, so
they are archived again.

    python3 -I scripts/chatgpt/seed-from-archive.py "<Downloads/ChatGPT Backup>" [--since 2026-11-05T15:36:00Z]

--since keeps only chats archived at or after that time (when an older archiver
revision wrote the earlier ones).
"""
import glob
import json
import os
import sys

REVISION = 2  # must match ARCHIVE_REVISION in src/archive/archive.js
RETRY_ERRORS = ("HTML_RESPONSE", "Invalid filename", "HTTP_OTHER", "MAGIC_MISMATCH", "TAB", "NO_RESULT")

archive = sys.argv[1]
since = sys.argv[sys.argv.index("--since") + 1] if "--since" in sys.argv else ""
out = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "chatgpt", "archive-state.json")
listed = {c["id"]: c for c in json.load(open(os.path.join(archive, "_conversations.json")))}

done, skipped = {}, 0
for path in glob.glob(os.path.join(archive, "*", "manifest.json")):
    manifest = json.load(open(path))
    summary = listed.get(manifest.get("id"))
    retry = any(not f.get("ok") and any(code in (f.get("error") or "") for code in RETRY_ERRORS) for f in manifest.get("files", []))
    if not summary or manifest.get("archived_at", "") < since or retry:
        skipped += 1
        continue
    done[manifest["id"]] = {
        "update_time": summary.get("update_time"),
        "folder": os.path.basename(os.path.dirname(path)),
        "stats": manifest.get("stats"),
        "fileIds": sorted({f["file_id"] for f in manifest.get("files", []) if f.get("ok") and f.get("file_id")}),
        "rev": REVISION,
    }
json.dump({"root": os.path.basename(os.path.normpath(archive)), "done": done}, open(out, "w"))
print(f"{out}: {len(done)} finished chats seeded, {skipped} left to archive again")
