#!/usr/bin/env python3
"""Independent completeness check for a ChatGPT Full archive folder.

For every chat folder it re-reads the raw conversation.json and checks, without using the
extension's code, that:
  - every message (all branches) is rendered once in transcript.md / branches.md
  - user messages and tool calls appear verbatim
  - every thought block appears verbatim in thinking.md and inline in the transcript
  - assistant replies are present line by line (widget replies are compared with the fallback
    Markdown ChatGPT stores for them; lines carrying citation markers are skipped because the
    archive renders them as links)
  - tool outputs are present (first 300 characters)
  - every attachment / asset pointer is saved, exists on disk and, unless the download was
    verified against ChatGPT's own size, matches the attachment's recorded size; files saved
    in another chat folder count as saved

    python3 -I scripts/verify-archive.py "<ChatGPT Full Archive>" [--samples]
"""
import collections
import glob
import json
import os
import re
import sys

root = sys.argv[1]
samples = "--samples" in sys.argv
FILE_ID = re.compile(r"file[-_](?!service:)[A-Za-z0-9_-]+")  # older pointers: file-service://file-AbC…
# A message heading, "## 12 · ChatGPT · 2025-05-09 03:28 · o3"; replies can contain their own "## 1 · …" headings.
HEADING = re.compile(r"^## \d+ · (?:You|ChatGPT|System|Tool · [^\n]*?|[a-z_]+) · (?:\d{4}-\d\d-\d\d \d\d:\d\d)?(?: · .*)?$", re.M)
MARKERS = re.compile(r"[^]*|[-]")
WIDGET = re.compile(r"<[A-Za-z][\w:-]*[\s>/]")
CAROUSEL = re.compile(r"\ue200(?:products|explore_more)\ue202([^\ue200\ue201]*)\ue201")


def json_rows(payload):
    try:
        return [row[:2] for row in json.loads(payload).get("selections", []) if isinstance(row, list) and len(row) > 1]
    except (ValueError, AttributeError):
        return []


ENTITY = re.compile(r'entity\["[^"]*","([^"]*)"[^]*')


def norm(text):
    # Content, not formatting: tags, Markdown escapes, links and emphasis; all on one line.
    text = re.sub(r"</?[A-Za-z][\w:-]*(?:\s[^<>\n]{0,400})?/?>", " ", text)
    text = re.sub(r"\\([\\`*_{}\[\]()#+\-.!:|>~<])", r"\1", text)
    text = re.sub(r"!?\[([^\]\n]{0,500})\]\([^)\s]{0,2000}\)", r"\1", text)
    text = text.replace("**", "").replace("__", "")
    return re.sub(r"\s+", " ", text).strip()


POINTER = re.compile(r"^(?:sediment|file-service)://")


def pointer_strings(value, path=""):
    if isinstance(value, str):
        if POINTER.match(value):
            yield path, value
    elif isinstance(value, list):
        for item in value:
            yield from pointer_strings(item, path + "[]")
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from pointer_strings(item, f"{path}.{key}")


def text_of(message):
    content = message.get("content") or {}
    if isinstance(content.get("parts"), list):
        return "\n".join(p for p in content["parts"] if isinstance(p, str))
    for key in ("text", "content"):
        if isinstance(content.get(key), str):
            return content[key]
    return ""


manifests = [m for m in sorted(glob.glob(os.path.join(root, "*", "manifest.json"))) if not os.path.basename(os.path.dirname(m)).startswith("_")]
saved_anywhere = set()
for path in manifests:
    for f in json.load(open(path))["files"]:
        if f.get("ok") and f.get("file_id"):
            saved_anywhere.add(f["file_id"])

totals = collections.Counter()
issues = collections.defaultdict(list)
for path in manifests:
    folder = os.path.dirname(path)
    manifest = json.load(open(path))
    conv = json.load(open(os.path.join(folder, "conversation.json")))
    read = lambda name: open(os.path.join(folder, name), encoding="utf-8", newline="").read() if os.path.exists(os.path.join(folder, name)) else ""
    transcript, branches, thinking = read("transcript.md"), read("branches.md"), read("thinking.md")
    normalized = {"transcript": norm(transcript), "branches": norm(branches)}
    name = f"{manifest['title'][:45]} [{manifest['id'][:8]}]"
    mapping = conv.get("mapping") or {}
    main, seen, node_id = [], set(), conv.get("current_node")
    while node_id and node_id in mapping and node_id not in seen:
        seen.add(node_id)
        main.insert(0, mapping[node_id])
        node_id = mapping[node_id].get("parent")
    main = [n for n in main if n.get("message")]
    others = [n for n in mapping.values() if n.get("message") and n["id"] not in seen]
    totals["chats"] += 1
    totals["messages"] += len(main) + len(others)
    totals["branch messages"] += len(others)
    if len(HEADING.findall(transcript)) != len(main):
        issues[name].append(f"transcript headings != main thread ({len(main)})")
    if len(re.findall(r"^## branch msg ", branches, re.M)) != len(others):
        issues[name].append(f"branches.md headings != branch messages ({len(others)})")

    for group, doc, key in ((main, transcript, "transcript"), (others, branches, "branches")):
        for node in group:
            message = node["message"]
            role = message["author"]["role"]
            ctype = (message.get("content") or {}).get("content_type")
            text = text_of(message)
            if ctype == "thoughts":
                for thought in message["content"].get("thoughts") or []:
                    body = thought.get("content") or ""
                    if body.strip():
                        totals["thought blocks"] += 1
                        if body not in thinking:
                            issues[name].append(f"thought of {message['id'][:8]} missing from thinking.md")
                        if body not in doc:
                            issues[name].append(f"thought of {message['id'][:8]} not inline")
                continue
            if not text.strip():
                continue
            if role == "user" or message.get("recipient") not in (None, "all"):
                totals["user messages / tool calls checked verbatim"] += 1
                if text not in doc:
                    issues[name].append(f"{'user text' if role == 'user' else 'tool call'} of {message['id'][:8]} not verbatim")
            elif role == "tool":
                totals["tool outputs checked"] += 1
                if text[:300] not in doc and ctype not in ("multimodal_text", "execution_output"):
                    issues[name].append(f"tool output of {message['id'][:8]} missing")
            elif role == "assistant":
                fallback = ((message.get("metadata") or {}).get("model_dil_v2") or {}).get("fallbackMarkdown")
                if fallback and WIDGET.search(text):
                    text = fallback
                    totals["widget replies checked against fallback"] += 1
                text = ENTITY.sub(r"\1", text)
                # Product carousels span lines of JSON; the archive shows their products, so check the names.
                text = CAROUSEL.sub(lambda m: "\n".join(n for _, n in json_rows(m.group(1))), text)
                lines = [norm(l) for l in text.split("\n") if len(l.strip()) >= 25 and not MARKERS.search(l) and not l.startswith(":::writing")]
                lines = [l for l in lines if "](" not in l and "【" not in l and len(l) >= 20]
                missing = [l for l in lines if l not in normalized[key]]
                totals["assistant lines checked"] += len(lines)
                totals["assistant lines missing"] += len(missing)
                if len(missing) > max(2, len(lines) // 20):
                    issues[name].append(f"{len(missing)}/{len(lines)} reply lines of {message['id'][:8]} missing")
                    if samples:
                        print("  SAMPLE", message["id"][:8], repr(missing[0][:160]))

    saved = {f["file_id"]: f for f in manifest["files"] if f.get("file_id") and f.get("ok")}
    failed = {f["file_id"]: f for f in manifest["files"] if f.get("file_id") and not f.get("ok")}
    for node in mapping.values():
        message = node.get("message")
        if not message:
            continue
        refs = [(FILE_ID.search(a.get("id", "")), a.get("size"), a.get("name")) for a in (message.get("metadata") or {}).get("attachments") or []]
        refs += [(FILE_ID.search(p.get("asset_pointer", "")), p.get("size_bytes"), "image")
                 for p in (message.get("content") or {}).get("parts") or [] if isinstance(p, dict) and p.get("asset_pointer")]
        # Any other stored-file pointer anywhere in the message (voice audio, screenshots, citations, …).
        refs += [(FILE_ID.search(value), None, path.lstrip(".")) for path, value in pointer_strings(message)]
        checked = set()
        for match, size, label in refs:
            if not match or match.group(0) in checked:
                continue
            file_id = match.group(0)
            checked.add(file_id)
            totals["file references"] += 1
            if file_id in saved:
                totals["file references saved"] += 1
                entry = saved[file_id]
                file_path = os.path.join(folder, entry["path"])
                if not os.path.exists(file_path):
                    issues[name].append(f"saved file missing on disk: {entry['path']}")
                elif isinstance(size, int) and size > 0 and os.path.getsize(file_path) != size and not entry.get("duplicate") and not entry.get("verified"):
                    issues[name].append(f"size mismatch {entry['path']}: {os.path.getsize(file_path)} vs {size}")
            elif file_id in saved_anywhere:
                totals["file references saved in another chat folder"] += 1
            else:
                error = (failed.get(file_id) or {}).get("error")
                totals[f"file references not saved ({error or 'never attempted'})"[:80]] += 1
                issues[name].append(f"file not saved: {label} {file_id} {error}")
    for entry in manifest["files"]:
        if not entry.get("ok"):
            totals["manifest failures"] += 1

print("TOTALS")
for key, value in totals.items():
    print(f"  {key}: {value}")
print(f"\nCHATS WITH ISSUES: {len(issues)}")
for key, values in issues.items():
    counts = collections.Counter(re.sub(r"\b[0-9a-f]{8}\b", "…", v) for v in values)
    print(f"  {key}")
    for text, n in counts.most_common(8):
        print(f"     {n}× {text}")
