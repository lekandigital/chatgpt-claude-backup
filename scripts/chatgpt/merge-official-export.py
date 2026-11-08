#!/usr/bin/env python3
"""Fold ChatGPT's official data export into a ChatGPT backup folder.

Run after a Back up all chats run has finished:

    python3 -I scripts/chatgpt/merge-official-export.py "<Downloads/ChatGPT Backup>" <export.zip> [--dry-run]

The live archive is richer than the export (widget Markdown, dictation pointers, citations,
reasoning times), so it stays the primary copy. The export fills what the live API can no
longer serve, and covers data the chat API does not reach:

  <chat>/uploads|outputs/   files the live run recorded as failed but the export still has
                            (manifest.json entries are updated: variant "official export")
  _library/                 every Library file: index.md/index.json, and files/ for the ones
                            not already saved in a chat folder
  _codex/                   Codex tasks as Markdown
  _official-export-only/    chats the export has but the archive does not (deleted since)
  _official-export/         the export's own JSON/HTML (copied separately; not touched here)
  _coverage.md              what came from where, and what is gone
"""
import collections
import glob
import json
import os
import re
import sys
import zipfile

args = [a for a in sys.argv[1:] if not a.startswith("--")]
archive, export_zip = args[0], args[1]
dry = "--dry-run" in sys.argv
zf = zipfile.ZipFile(export_zip)
members = {}
for name in zf.namelist():
    base = os.path.basename(name)
    m = re.match(r"(file[-_][A-Za-z0-9_-]+)(?:\.[A-Za-z0-9]+)?$", base)
    if m and "/" not in name.strip("/"):
        members[m.group(1)] = name


def load(name, default):
    try:
        return json.loads(zf.read(name))
    except KeyError:
        return default


asset_names = {k.rsplit(".", 1)[0]: v for k, v in load("conversation_asset_file_names.json", {}).items()}
library = load("library_files.json", [])
library_names = {f["file_id"]: f.get("file_name") for f in library if f.get("file_id")}
conversations = {}
for name in sorted(n for n in zf.namelist() if re.match(r"conversations-\d+\.json$", n)):
    for conv in json.loads(zf.read(name)):
        conversations[conv.get("conversation_id") or conv.get("id")] = conv


def safe(name, fallback="file", limit=90):
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*~]', "_", str(name or "")).strip().strip(".")
    base, ext = os.path.splitext(name)
    return (base[: limit - len(ext)] + ext) if name else fallback


def unique(folder, name):
    path = os.path.join(folder, name)
    base, ext = os.path.splitext(name)
    n = 2
    while os.path.exists(path):
        path = os.path.join(folder, f"{base} ({n}){ext}")
        n += 1
    return path


def extract(file_id, folder, name):
    target = unique(folder, safe(name or library_names.get(file_id) or asset_names.get(file_id) or file_id))
    if not dry:
        os.makedirs(folder, exist_ok=True)
        with zf.open(members[file_id]) as src, open(target, "wb") as dst:
            while chunk := src.read(1 << 20):
                dst.write(chunk)
    return target


# 1. Chat folders: recover failed files the export still has.
saved_ids, folder_by_chat = {}, {}
recovered, still_failed = collections.Counter(), collections.Counter()
for manifest_path in sorted(glob.glob(os.path.join(archive, "*", "manifest.json"))):
    folder = os.path.dirname(manifest_path)
    if os.path.basename(folder).startswith("_"):
        continue
    manifest = json.load(open(manifest_path))
    folder_by_chat[manifest["id"]] = folder
    changed = False
    relinks = []  # (shown name, new relative path, where it came from) for the transcripts
    for entry in manifest["files"]:
        file_id = entry.get("file_id")
        if entry.get("ok") and file_id and entry.get("path"):
            saved_ids.setdefault(file_id, os.path.join(folder, entry["path"]))
    for entry in manifest["files"]:
        file_id = entry.get("file_id")
        if entry.get("ok") or not file_id:
            if not entry.get("ok"):
                still_failed["no file id (sandbox link)"] += 1
            continue
        if file_id in saved_ids:
            entry.update(ok=True, path=os.path.relpath(saved_ids[file_id], folder), variant="saved elsewhere in this chat or archive")
            relinks.append((entry.get("name") or file_id, entry["path"], "saved in another chat folder"))
            recovered["already saved elsewhere"] += 1
            changed = True
        elif file_id in members:
            sub = "uploads" if entry.get("kind") == "upload" else "outputs"
            target = extract(file_id, os.path.join(folder, sub), entry.get("name"))
            saved_ids[file_id] = target
            entry.update(ok=True, path=os.path.relpath(target, folder), variant="official export", live_error=entry.get("error"))
            entry.pop("error", None)
            relinks.append((entry.get("name") or file_id, entry["path"], "from ChatGPT's official export"))
            recovered["from the official export"] += 1
            changed = True
        else:
            still_failed[(entry.get("error") or "")[:40]] += 1
    if changed and not dry:
        manifest["stats"]["failed"] = sum(1 for f in manifest["files"] if not f.get("ok"))
        json.dump(manifest, open(manifest_path, "w"), indent=2, ensure_ascii=False)
        # The transcripts list a failed attachment as "📎 <name> (not downloadable)"; link the recovered copy.
        for doc in ("transcript.md", "branches.md", "chatgpt-view.md"):
            doc_path = os.path.join(folder, doc)
            if not os.path.exists(doc_path):
                continue
            text = original = open(doc_path, encoding="utf-8", newline="").read()
            for name, rel, source in relinks:
                link = "<" + rel.replace(os.sep, "/").replace(">", "%3E") + ">"
                text = text.replace(f"📎 {name} (not downloadable)", f"📎 [{name}]({link}) ({source})")
            if text != original:
                open(doc_path, "w", encoding="utf-8", newline="").write(text)
                recovered["chat folders whose transcripts now link them"] += 1

# 2. Library.
library_dir = os.path.join(archive, "_library")
rows, lib_counts = [], collections.Counter()
for f in sorted(library, key=lambda f: f.get("created_at") or ""):
    file_id = f.get("file_id")
    chat = f.get("origination_thread_id")
    row = {"file_id": file_id, "name": f.get("file_name"), "mime": f.get("mime_type"), "size": f.get("file_size_bytes"),
           "created": f.get("created_at"), "chat": chat, "deleted_at": f.get("deleted_at")}
    if file_id in saved_ids:
        row["path"] = os.path.relpath(saved_ids[file_id], archive)
        lib_counts["saved in a chat folder"] += 1
    elif file_id in members:
        row["path"] = os.path.relpath(extract(file_id, os.path.join(library_dir, "files"), f.get("file_name")), archive)
        saved_ids[file_id] = os.path.join(archive, row["path"])
        lib_counts["saved from the export into _library/files"] += 1
    else:
        lib_counts["not in the export"] += 1
    rows.append(row)
if not dry and rows:
    os.makedirs(library_dir, exist_ok=True)
    json.dump(rows, open(os.path.join(library_dir, "index.json"), "w"), indent=1, ensure_ascii=False)
    lines = ["# ChatGPT Library", "", f"{len(rows)} files.", "", "| Created | File | Type | Chat |", "|---|---|---|---|"]
    for r in rows:
        name = str(r["name"] or r["file_id"]).replace("|", "\\|")
        link = f"[{name}](<{r['path']}>)" if r.get("path") else f"{name} (not available)"
        chat = folder_by_chat.get(r["chat"])
        lines.append(f"| {str(r['created'])[:10]} | {link} | {r['mime'] or ''} | {f'[chat](<{os.path.relpath(chat, archive)}/transcript.md>)' if chat else (r['chat'] or '')} |")
    open(os.path.join(library_dir, "index.md"), "w").write("\n".join(lines) + "\n")

# 3. Codex tasks.
codex = load("codex.json", [])
if not dry and codex:
    os.makedirs(os.path.join(archive, "_codex"), exist_ok=True)
    for task in codex:
        body = [f"# {task.get('title') or task.get('id')}", "", f"- Task: {task.get('id')}", f"- Archived: {task.get('archived')}", ""]
        for i, turn in enumerate(task.get("turns") or [], 1):
            body += [f"## Turn {i}", "", "```json", json.dumps(turn, indent=2, ensure_ascii=False), "```", ""]
        open(os.path.join(archive, "_codex", safe(task.get("title") or task.get("id"), "task") + ".md"), "w").write("\n".join(body))

# 4. Chats only the export has.
only = [c for cid, c in conversations.items() if cid not in folder_by_chat]
for conv in only:
    if dry:
        continue
    created = conv.get("create_time")
    date = __import__("datetime").datetime.utcfromtimestamp(created).strftime("%Y-%m-%d") if isinstance(created, (int, float)) else "unknown-date"
    folder = os.path.join(archive, "_official-export-only", f"{date} {safe(conv.get('title'), 'Untitled', 70)} [{(conv.get('conversation_id') or conv.get('id'))[:8]}]")
    os.makedirs(folder, exist_ok=True)
    json.dump(conv, open(os.path.join(folder, "conversation.json"), "w"), indent=2, ensure_ascii=False)

# 5. Coverage.
live_thoughts = export_thoughts = 0
for cid, conv in conversations.items():
    for node in (conv.get("mapping") or {}).values():
        if ((node.get("message") or {}).get("content") or {}).get("content_type") == "thoughts":
            export_thoughts += 1
report = ["# Coverage vs ChatGPT's official export", "",
          f"- Export: {len(conversations)} chats, {len(members)} files, {len(library)} Library entries, {len(codex)} Codex tasks",
          f"- Archive: {len(folder_by_chat)} chats fetched live; {len(only)} chats only in the export (in _official-export-only/)", "",
          "## Files the live run could not fetch", ""] + [f"- {k}: **{v}**" for k, v in recovered.items()] + \
         [f"- still unavailable ({k or 'no detail'}): **{v}**" for k, v in still_failed.most_common()] + \
         ["", "## Library", ""] + [f"- {k}: **{v}**" for k, v in lib_counts.items()] + \
         ["", "## Kept as-is", "", "- `_official-export/`: the export's JSON and chat.html (full text of every chat as of the export)",
          "- The live copy of each chat (`conversation.json`) is richer than the export: widget Markdown, voice-dictation pointers, citations and reasoning times are only there.", ""]
if not dry:
    open(os.path.join(archive, "_coverage.md"), "w").write("\n".join(report))
print(("DRY RUN — nothing written\n" if dry else "") + "\n".join(report))
