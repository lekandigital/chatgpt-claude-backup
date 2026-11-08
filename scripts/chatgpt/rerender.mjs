#!/usr/bin/env node
// Rebuilds a ChatGPT backup's transcripts from the saved conversation.json files, offline, with the
// extension's own renderer (src/chatgpt/core/transcript.js + src/chatgpt/archive/render.js). Use it after a
// rendering fix instead of asking ChatGPT for every chat again.
//
//   node scripts/chatgpt/rerender.mjs "<Downloads/ChatGPT Backup>"            report which chats would change
//   node scripts/chatgpt/rerender.mjs "<Downloads/ChatGPT Backup>" --write    rewrite only the files that change
//   … --ids=<id,id>                                                 limit to some chats
//
// Links to saved files come from each chat's manifest.json (file id → saved path), so files
// recovered later (e.g. by merge-official-export.py) are linked too. The project and archived
// lines of the transcript header are kept from the existing transcript.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const root = args.find(a => !a.startsWith('--'));
const write = args.includes('--write');
const only = new Set((args.find(a => a.startsWith('--ids=')) || '').slice(6).split(',').filter(Boolean));
if (!root) { console.error('usage: node scripts/chatgpt/rerender.mjs "<Downloads/ChatGPT Backup>" [--write] [--ids=…]'); process.exit(2); }

const read = rel => fs.readFileSync(path.join(here, '..', '..', 'src', 'chatgpt', rel), 'utf8');
const { version } = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8'));
const context = vm.createContext({ console, URL });
const { ArchiveRender } = vm.runInContext(`
  const Config = Object.freeze({ ORIGIN: 'https://chatgpt.com', VERSION: ${JSON.stringify(version)} });
  ${read('core/transcript.js')}
  ${read('archive/render.js')}
  ({ ArchiveRender })`, context);

const DOCS = ['transcript.md', 'chatgpt-view.md', 'branches.md', 'thinking.md'];
const totals = { chats: 0, unchanged: 0, changed: 0, written: 0, files: {} };
const changedChats = [];
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
  const folder = path.join(root, entry.name);
  const manifestPath = path.join(folder, 'manifest.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (only.size && !only.has(manifest.id)) continue;
  const conv = JSON.parse(fs.readFileSync(path.join(folder, 'conversation.json'), 'utf8'));
  const names = new Map();
  for (const file of manifest.files) if (file.ok && file.file_id && file.path && !names.has(file.file_id)) names.set(file.file_id, file.path.split(path.sep).join('/'));
  const current = Object.fromEntries(DOCS.map(doc => [doc, fs.existsSync(path.join(folder, doc)) ? fs.readFileSync(path.join(folder, doc), 'utf8') : null]));
  const header = current['transcript.md'] || '';
  const project = /^- Project: (.*)$/m.exec(header.split('\n## ')[0])?.[1] || null;
  const isArchived = /^- Archived in ChatGPT$/m.test(header.split('\n## ')[0]);
  const docs = ArchiveRender.documents(conv, { id: manifest.id, title: manifest.title, project, is_archived: isArchived }, names);
  // chatgpt-view.md says when it was exported; keep the original time so only real changes count.
  const exported = /^- Exported: .*$/m.exec(current['chatgpt-view.md'] || '')?.[0];
  if (exported && docs['chatgpt-view.md']) docs['chatgpt-view.md'] = docs['chatgpt-view.md'].replace(/^- Exported: .*$/m, () => exported);
  totals.chats++;
  const diff = DOCS.filter(doc => docs[doc] != null && docs[doc] !== current[doc]);
  if (!diff.length) { totals.unchanged++; continue; }
  totals.changed++;
  changedChats.push(`${entry.name}: ${diff.join(', ')}`);
  for (const doc of diff) totals.files[doc] = (totals.files[doc] || 0) + 1;
  if (write) {
    for (const doc of diff) { fs.writeFileSync(path.join(folder, doc), docs[doc]); totals.written++; }
    manifest.rerendered_at = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}
console.log(JSON.stringify(totals, null, 2));
console.log(changedChats.join('\n'));
