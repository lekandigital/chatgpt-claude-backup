// Full archive: every ChatGPT chat as its own folder under Downloads/<root>/.
// Runs in its own extension tab, so a long export is not at the mercy of service-worker
// suspension. All chatgpt.com requests run inside a background chatgpt.com tab through the
// archive-page.js API (credentials never leave that page); this page only receives JSON and
// file bytes and writes them with chrome.downloads. Finished chats are remembered per root
// folder, so a rerun only redoes chats that are new or changed.
const STATE_KEY = 'cga:archive-state';
const WORKER_KEY = 'cga:worker-tabs';
// Bump when the archiver captures more: chats saved by an older revision are archived again.
const ARCHIVE_REVISION = 2;
const DEFAULT_ROOT = 'ChatGPT Full Archive';
const API_SYMBOL = 'chatgpt-attachment-downloader-archive-v1';
const API_DELAY_MS = 1200;
// ChatGPT allows a burst of ~200 conversation reads, then refills slowly: rest every 80 reads.
const REST_EVERY = 80;
const REST_MS = 25000;
const FILE_DELAY_MS = 600;
const LIST_LIMIT = 100;
const CHUNK_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180000;

const { FILE_ID, fileIdOf, messageText, messageTree, fence, clip, mdLink, toIso, isoDate, isoTime } = ArchiveRender;

const params = new URLSearchParams(location.search);
const els = Object.fromEntries(['root', 'ids', 'force', 'run-all', 'run-some', 'stop', 'progress-fill', 'summary', 'log',
  'load-list', 'filter', 'select-shown', 'select-none', 'picked-count', 'chat-list']
  .map(id => [id, document.getElementById(id)]));

let stopRequested = false;
const savedFileIds = new Set();
let workerTabId = null;
let rootDir = DEFAULT_ROOT;
let status = null;
let requestCount = 0;
let lastSavedBytes = null;
let cooldownMs = 0;
// archive-page.js sits next to the archive/ folder, wherever this extension keeps it.
const PAGE_BUNDLE = new URL('../archive-page.js', location.href).pathname.slice(1);

// ── Timing (worker clock: hidden tabs throttle page timers to once a minute) ──

const timerWorker = new Worker('timer.js');
const pendingTimers = new Map();
let timerSeq = 0;
timerWorker.onmessage = event => { pendingTimers.get(event.data)?.(); pendingTimers.delete(event.data); };
const sleep = ms => new Promise(resolve => {
  const id = ++timerSeq;
  pendingTimers.set(id, resolve);
  timerWorker.postMessage({ id, ms });
});
function withTimeout(promise, ms, label) {
  let done = false;
  return Promise.race([
    promise.finally(() => (done = true)),
    sleep(ms).then(() => { if (!done) throw new Error(`${label} timed out after ${Math.round(ms / 1000)}s`); }),
  ]);
}

// ── Small helpers ──

function log(message) {
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  const lines = els.log.textContent.split('\n').slice(-400);
  lines.push(line);
  els.log.textContent = lines.join('\n');
  els.log.scrollTop = els.log.scrollHeight;
  if (status) {
    status.log.push(line);
    if (status.log.length > 60) status.log.shift();
    scheduleHeartbeat();
  }
}

function safeSegment(name, fallback = 'untitled', max = 90) {
  // Chrome's downloads API rejects control, surrogate, private-use and unassigned (noncharacter)
  // code points, e.g. a chat titled "Next Steps \u{5FFFF}"; bidi controls are replaced too.
  let s = String(name ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*~\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/[\p{Cc}\p{Cs}\p{Co}\p{Cn}]/gu, '')
    .replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > max) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 8 ? s.slice(dot) : '';
    s = s.slice(0, max - ext.length).trim() + ext;
  }
  return s || fallback;
}
function safePath(relPath) {
  return relPath.split('/').filter(part => part && part !== '.' && part !== '..').map(part => safeSegment(part, 'untitled', 150)).join('/');
}
// Unique names inside one chat folder; room is left for " (n)" so truncation never merges two files.
function makeNamer() {
  const used = new Set();
  return (dir, name) => {
    const clean = safeSegment(name, 'file', 80);
    const dot = clean.lastIndexOf('.');
    const base = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : '';
    let candidate = `${dir}/${clean}`;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${dir}/${base} (${n})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
}
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const MIME_BY_EXT = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', json: 'application/json',
  zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
// Chrome rewrites a download's extension to match its MIME type, so blobs are labelled by name.
function mimeForName(name) {
  const ext = /\.([a-z0-9]{1,6})$/i.exec(name)?.[1].toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}
function withExtension(name, mime) {
  if (/\.[a-z0-9]{1,6}$/i.test(name)) return name;
  const ext = Object.entries(MIME_BY_EXT).find(([, m]) => m === String(mime || '').split(';')[0].trim().toLowerCase())?.[0];
  return ext ? `${name}.${ext}` : name;
}

// ── The chatgpt.com worker tab ──

async function waitForTabComplete(tabId, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await chrome.tabs.get(tabId)).status === 'complete') return;
    await sleep(250);
  }
  throw new Error('chatgpt.com tab did not finish loading');
}
async function ensureWorkerTab() {
  if (workerTabId !== null) {
    try {
      const tab = await chrome.tabs.get(workerTabId);
      if (tab.url?.startsWith('https://chatgpt.com/')) { await waitForTabComplete(workerTabId); return workerTabId; }
    } catch { /* Closed: open a new one. */ }
    workerTabId = null;
  }
  // Each archive page owns one worker tab. Close workers whose page is gone (an interrupted
  // run), never one that another archive page is still using.
  const owner = (await chrome.tabs.getCurrent())?.id ?? 0;
  const { [WORKER_KEY]: owners = {} } = await chrome.storage.local.get(WORKER_KEY);
  for (const [page, worker] of Object.entries(owners)) {
    const alive = Number(page) !== owner && await chrome.tabs.get(Number(page)).then(() => true, () => false);
    if (alive) continue;
    const old = await chrome.tabs.get(worker).catch(() => null);
    if (old?.url?.startsWith('https://chatgpt.com/')) await chrome.tabs.remove(worker).catch(() => {});
    delete owners[page];
  }
  const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
  workerTabId = tab.id;
  owners[owner] = tab.id;
  await chrome.storage.local.set({ [WORKER_KEY]: owners });
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await waitForTabComplete(tab.id);
  return workerTabId;
}
function closeWorkerTab() {
  if (workerTabId !== null) chrome.tabs.remove(workerTabId).catch(() => {});
  workerTabId = null;
}
// Calls one method of the page API; installs it on first use and after the tab reloads.
async function pageCall(method, args = [], timeoutMs = 120000) {
  let last = { ok: false, code: 'NOT_RUN' };
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const tabId = await ensureWorkerTab();
      const [injection] = await withTimeout(chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', args: [API_SYMBOL, method, args],
        func: (symbol, name, values) => {
          const api = window[Symbol.for(symbol)];
          return api ? api[name](...values) : { ok: false, code: 'NOT_INSTALLED' };
        },
      }), timeoutMs, `page ${method}`);
      last = injection?.result || { ok: false, code: 'NO_RESULT' };
      if (last.code === 'NOT_INSTALLED') {
        await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [PAGE_BUNDLE] });
        continue;
      }
      if (last.code === 'AUTH_WAITING' && attempt < 4) {
        log('  waiting for the ChatGPT session…');
        await sleep(5000);
        continue;
      }
      return last;
    } catch (error) {
      last = { ok: false, code: 'TAB', message: error.message };
      log(`  page call problem (${error.message}); reopening the chatgpt.com tab`);
      closeWorkerTab();
      await sleep(2000);
    }
  }
  return last;
}
// Rate limits pause the whole run (2 min doubling to 15 min) and retry the same request.
async function rateLimited(task) {
  for (;;) {
    const result = await task();
    if (result?.code !== 'HTTP_429' || stopRequested) { if (result?.ok) cooldownMs = 0; return result; }
    cooldownMs = Math.min(15 * 60000, cooldownMs ? cooldownMs * 2 : 120000);
    log(`  rate limited by ChatGPT — pausing ${Math.round(cooldownMs / 60000)} min`);
    if (status) await writeStatus({ cooldown_until: new Date(Date.now() + cooldownMs).toISOString() });
    await sleep(cooldownMs);
  }
}
async function apiJson(path) {
  await sleep(API_DELAY_MS);
  if (++requestCount % REST_EVERY === 0) await sleep(REST_MS);
  const result = await rateLimited(() => pageCall('json', [path]));
  if (!result.ok) {
    const error = new Error(`${path} → ${result.code}${result.message && result.message !== result.code ? ` ${result.message}` : ''}`);
    error.code = result.code;
    throw error;
  }
  return result.value;
}

// ── Writing into Downloads/<root>/ ──

// Danger states that leave a download paused until someone clicks "Keep".
const BLOCKING_DANGER = new Set(['file', 'url', 'content', 'uncommon', 'host', 'unwanted', 'accountCompromise']);
function waitForDownload(id, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  return new Promise(resolve => {
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(outcome);
    };
    const inspect = item => {
      if (!item) return;
      if (item.state === 'complete') finish({ state: 'complete' });
      else if (item.state === 'interrupted') finish({ state: 'interrupted', error: item.error });
      else if (BLOCKING_DANGER.has(item.danger)) finish({ state: 'dangerous', error: item.danger });
    };
    const onChanged = delta => {
      if (delta.id === id && (delta.state || delta.danger || delta.error)) chrome.downloads.search({ id }).then(([item]) => inspect(item));
    };
    sleep(timeoutMs).then(() => finish({ state: 'timeout' }));
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => inspect(item));
  });
}
// Path (relative to the root folder) of the file Chrome actually wrote.
async function finalRelativePath(id, requested) {
  const [item] = await chrome.downloads.search({ id });
  lastSavedBytes = Number.isFinite(item?.fileSize) && item.fileSize >= 0 ? item.fileSize : null;
  const marker = `/${rootDir}/`;
  const at = item?.filename ? item.filename.lastIndexOf(marker) : -1;
  return at >= 0 ? item.filename.slice(at + marker.length) : requested.slice(rootDir.length + 1);
}
async function saveFromUrl(relPath, url, size) {
  let filename = `${rootDir}/${safePath(relPath)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = await withTimeout(chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false }),
      60000, `starting download of ${filename}`);
    const outcome = await waitForDownload(id, size < 5 * 1048576 ? 45000 : DOWNLOAD_TIMEOUT_MS);
    if (outcome.state === 'complete') {
      const savedAs = await finalRelativePath(id, filename);
      chrome.downloads.erase({ id });
      return savedAs;
    }
    await chrome.downloads.cancel(id).catch(() => {});
    chrome.downloads.erase({ id });
    // Chrome holds some types (.py, .sh…) for a manual "Keep" click; save those as .txt instead.
    if (outcome.state === 'dangerous' && attempt === 0) { filename += '.txt'; continue; }
    if (outcome.state === 'timeout' && attempt === 0) { log(`  download stalled, retrying: ${filename}`); continue; }
    throw new Error(`download ${outcome.state}${outcome.error ? `: ${outcome.error}` : ''}`);
  }
}
async function saveBlob(relPath, blob) {
  const url = URL.createObjectURL(blob);
  try { return await saveFromUrl(relPath, url, blob.size); } finally { URL.revokeObjectURL(url); }
}
function saveText(relPath, text, mime = 'text/plain') { return saveBlob(relPath, new Blob([text], { type: `${mime};charset=utf-8` })); }
function saveJson(relPath, value) { return saveText(relPath, JSON.stringify(value, null, 2), 'application/json'); }

// Downloads one file through the page API (verified chain: metadata → signed link → size/magic
// checks) and writes it. Returns { ok, savedAs, … } or { ok: false, error }.
async function sha256(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// seen: per-chat Map of SHA-256 → saved path, so a file ChatGPT registers twice is written once.
async function fetchFile(spec, relPathFor, seen = null) {
  await sleep(FILE_DELAY_MS);
  const result = await rateLimited(() => pageCall('file', [spec], 15 * 60000));
  if (!result.ok) return { ok: false, error: `${result.code}${result.expected != null ? ` (expected ${result.expected} bytes, got ${result.actual})` : ''}` };
  const file = result.value;
  try {
    if (file.link) {
      const savedAs = await saveFromUrl(relPathFor(file.filename || spec.filename), file.link, file.expectedSize || 0);
      return { ok: true, savedAs, variant: 'signed-link', verified: false };
    }
    const parts = [];
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      const piece = await pageCall('chunk', [file.handle, offset, CHUNK_BYTES], 180000);
      if (!piece.ok) throw new Error(`reading bytes: ${piece.code}`);
      parts.push(base64ToBytes(piece.value));
    }
    const realExt = /\.[a-z0-9]{1,6}$/i.exec(file.filename || '')?.[0] || '';
    const preferred = spec.preferName && !/\.[a-z0-9]{1,6}$/i.test(spec.preferName) ? spec.preferName + realExt : spec.preferName;
    const name = withExtension(preferred || file.filename || spec.filename, file.mime);
    const blob = new Blob(parts, { type: mimeForName(name) });
    const hash = seen ? await sha256(blob) : null;
    if (hash && seen.has(hash)) return { ok: true, savedAs: seen.get(hash), duplicate: true, bytes: file.size, verified: file.verified };
    const savedAs = await saveBlob(relPathFor(name), blob);
    if (hash) seen.set(hash, savedAs);
    return { ok: true, savedAs, bytes: file.size, verified: file.verified, mime: file.mime, sha256: hash };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (file.handle) pageCall('release', [file.handle], 30000).catch(() => {});
  }
}

// ── Conversation structure ──


// Every file a chat mentions, with who produced it (user → uploads/, everything else → outputs/).
function discoverFiles(conv) {
  const files = new Map();
  const add = (id, info) => {
    if (!id) return;
    const entry = files.get(id) || { id };
    for (const [key, value] of Object.entries(info)) if (value != null && value !== '' && entry[key] == null) entry[key] = value;
    files.set(id, entry);
  };
  for (const node of Object.values(conv.mapping || {})) {
    const message = node?.message;
    if (!message) continue;
    const role = message.author?.role;
    const meta = message.metadata || {};
    for (const item of meta.attachments || []) {
      add(fileIdOf(item.id), { name: item.name, size: item.size, mime: item.mime_type, role, messageId: message.id });
    }
    for (const part of message.content?.parts || []) {
      if (part && typeof part === 'object' && part.asset_pointer) {
        const id = fileIdOf(part.asset_pointer);
        const generated = part.metadata?.dalle || part.metadata?.generation;
        add(id, { size: part.size_bytes, role, messageId: message.id,
          name: generated ? `generated image ${id?.slice(-8)}` : null, kind: part.content_type });
      }
    }
    for (const item of meta.aggregate_result?.messages || []) {
      if (item?.message_type === 'image') add(fileIdOf(item.image_url), { role: 'tool', messageId: message.id, name: `chart ${fileIdOf(item.image_url)?.slice(-8)}` });
      if (item?.audio_url) add(fileIdOf(item.audio_url), { role: 'tool', messageId: message.id, name: `audio ${fileIdOf(item.audio_url)?.slice(-8)}` });
    }
    // Your voice dictation of this message, and screenshots the agent's browser took.
    if (meta.dictation_asset_pointer) add(fileIdOf(meta.dictation_asset_pointer), { role, messageId: message.id, name: `voice dictation ${message.id.slice(0, 8)}`, prefer: true });
    for (const shot of meta.flora_browser_screenshots || []) {
      const id = fileIdOf(shot?.image_asset_pointer?.asset_pointer || shot?.asset_pointer);
      add(id, { role: 'tool', messageId: message.id, name: `browser screenshot ${id?.slice(-8)}`, prefer: true });
    }
  }
  // Catch-all: any other stored-file pointer anywhere in a message, so a new or nested format is not
  // silently skipped. Seen so far: your own voice in voice-mode chats (parts[].audio_asset_pointer),
  // agent screenshots (content.screenshot), file-search citations, and widget/product images.
  for (const node of Object.values(conv.mapping || {})) {
    const message = node?.message;
    if (!message) continue;
    for (const { id, path } of pointersIn(message)) {
      if (!id || files.has(id)) continue;
      const what = /audio/i.test(path) ? 'voice audio' : /screenshot/i.test(path) ? 'screenshot'
        : /citation|content_references/i.test(path) ? 'cited file' : 'file';
      add(id, { role: message.author?.role, messageId: message.id, name: `${what} ${id.slice(-8)}`, prefer: what !== 'cited file' });
    }
  }
  return files;
}

const POINTER = /^(?:sediment|file-service):\/\//;
function pointersIn(value, path = '', out = []) {
  if (typeof value === 'string') { if (POINTER.test(value)) out.push({ id: fileIdOf(value), path }); }
  else if (Array.isArray(value)) for (const item of value) pointersIn(item, path, out);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) pointersIn(item, `${path}.${key}`, out);
  return out;
}

// Files the Code Interpreter wrote, linked as sandbox:/mnt/data/… in a reply.
function sandboxLinks(conv) {
  const links = new Map();
  for (const node of Object.values(conv.mapping || {})) {
    const message = node?.message;
    if (!message || message.author?.role === 'user') continue;
    const text = messageText(message).replace(/```[\s\S]*?```/g, '') + JSON.stringify(message.metadata?.content_references || []);
    for (const match of text.matchAll(/sandbox:(\/mnt\/data\/[^\s)"'\]<>]+)/g)) {
      let path = match[1].replace(/[.,;:]+$/, '');
      try { path = decodeURIComponent(path); } catch { /* keep as is */ }
      if (!links.has(path)) links.set(path, []);
      if (!links.get(path).includes(message.id)) links.get(path).push(message.id);
    }
  }
  return links;
}

// Canvas documents, rebuilt from canmore create/update calls in tree order.
function canvasDocs(main) {
  const docs = [];
  let current = null;
  for (const node of main) {
    const message = node.message;
    const recipient = message.recipient || '';
    if (!recipient.startsWith('canmore.')) continue;
    let input;
    try { input = JSON.parse(messageText(message)); } catch { continue; }
    if (recipient === 'canmore.create_textdoc') {
      current = { name: input.name || 'canvas', type: input.type || 'document', content: String(input.content ?? ''), versions: 1, failedUpdates: 0 };
      docs.push(current);
    } else if (recipient === 'canmore.update_textdoc' && current) {
      for (const update of input.updates || []) {
        try {
          const pattern = new RegExp(update.pattern, `s${update.multiple ? 'g' : ''}`);
          const replacement = String(update.replacement ?? '').replace(/\$/g, '$$$$').replace(/\\(\d)/g, '$$$1');
          const next = current.content.replace(pattern, replacement);
          if (next === current.content && !pattern.test(current.content)) current.failedUpdates++;
          current.content = next;
        } catch { current.failedUpdates++; }
      }
      current.versions++;
    }
  }
  return docs;
}
const CANVAS_EXT = { document: '.md', 'code/python': '.py', 'code/javascript': '.js', 'code/typescript': '.ts', 'code/html': '.html',
  'code/react': '.jsx', 'code/css': '.css', 'code/java': '.java', 'code/cpp': '.cpp', 'code/rust': '.rs', 'code/go': '.go', 'code/sql': '.sql' };

// ── Markdown rendering ──

// ── Per-chat archive ──

async function archiveConversation(summary, folder, prefetched = null) {
  const conv = prefetched || await apiJson(`/backend-api/conversation/${summary.id}`);
  const files = [];
  const record = entry => files.push(entry);
  const nameIn = makeNamer();
  await saveJson(`${folder}/conversation.json`, conv);
  record({ path: 'conversation.json', kind: 'raw', ok: true });

  const { main, others } = messageTree(conv);
  const names = new Map();

  // Files: what the tree mentions plus the server's list for this chat.
  const discovered = discoverFiles(conv);
  const listed = await pageCall('scanFiles', [summary.id], 5 * 60000);
  if (listed.ok) {
    for (const item of listed.value.files || []) {
      const entry = discovered.get(item.id) || { id: item.id, role: null };
      entry.name ??= item.filename; entry.size ??= item.expectedSize; entry.mime ??= item.mime;
      discovered.set(item.id, entry);
    }
  } else if (listed.code !== 'HTTP_404') {
    log(`  file list unavailable (${listed.code})`);
  }
  const seen = new Map();
  const savedSandbox = new Map();
  for (const file of discovered.values()) {
    // ChatGPT registers files its sandbox wrote under their path (_mnt_data_report.pdf).
    const sandboxName = /^_mnt_data_(.+)$/.exec(file.name || '')?.[1] || null;
    const dir = file.role === 'user' ? 'uploads' : file.role || sandboxName ? 'outputs' : 'files';
    const fallback = sandboxName || file.name || `file ${file.id.slice(-12)}`;
    const routes = [null, `/backend-api/conversation/${summary.id}/attachment/${file.id}/download`,
      `/backend-api/files/download/${file.id}?conversation_id=${summary.id}&inline=false&download_intent=true`, `/backend-api/files/${file.id}/download`];
    let result;
    let routed = null;
    const errors = [];
    // The download may only reveal the sandbox origin through its name (_mnt_data_…): those
    // are ChatGPT's outputs and go to outputs/ under the clean name.
    const placeFile = name => {
      const clean = /^_mnt_data_(.+)$/.exec(name)?.[1];
      if (clean && dir !== 'uploads') { routed = clean; return nameIn(`${folder}/outputs`, clean); }
      return nameIn(`${folder}/${dir}`, name);
    };
    for (const url of routes) {
      result = await fetchFile({ conversationId: summary.id, id: file.id, url, filename: fallback, expectedSize: file.size || null,
        preferName: sandboxName || (file.prefer ? file.name : null) }, placeFile, seen);
      if (result.ok || !/HTTP_40[34]|HTTP_OTHER/.test(result.error)) break;
      errors.push(result.error);
    }
    if (!result.ok && /HTTP_OTHER/.test(result.error)) {
      // ChatGPT's file store answers 415 to page fetches of some types (.js); Chrome's own
      // downloader gets them. The saved size is checked against ChatGPT's record.
      try {
        const meta = await apiJson(`/backend-api/files/download/${file.id}?conversation_id=${summary.id}&inline=false&download_intent=true`);
        if (typeof meta?.download_url === 'string') {
          const url = new URL(meta.download_url, 'https://chatgpt.com');
          if (url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.oaiusercontent.com'))) {
            const name = String(meta.file_name || fallback).replace(/\//g, '_');
            const savedAs = await saveFromUrl(placeFile(name), url.href, Number(meta.file_size_bytes) || 0);
            const expected = Number.isSafeInteger(meta.file_size_bytes) ? meta.file_size_bytes : null;
            result = { ok: expected === null || lastSavedBytes === expected, savedAs, bytes: lastSavedBytes, verified: expected !== null && lastSavedBytes === expected, variant: 'chrome-download' };
            if (!result.ok) result.error = `chrome download size ${lastSavedBytes} ≠ ${expected}`;
          }
        }
      } catch (error) { errors.push(`chrome download: ${error.message}`); }
    }
    if (!result.ok && errors.length) result.error = [...new Set([...errors, result.error])].join(' / ');
    if (!result.ok && /SERVER_FAILED/.test(result.error || '')) result.error = `ChatGPT refuses to serve this file type (HTTP 415): ${result.error}`;
    if (result.ok) {
      const local = result.savedAs.slice(folder.length + 1);
      names.set(file.id, local);
      if (sandboxName || routed) savedSandbox.set((sandboxName || routed).toLowerCase(), local);
      record({ path: local, kind: dir === 'uploads' ? 'upload' : 'output', ok: true, file_id: file.id, name: file.name,
        bytes: result.bytes, verified: result.verified, variant: result.variant, duplicate: result.duplicate || undefined });
    } else {
      record({ path: null, kind: dir === 'uploads' ? 'upload' : 'output', ok: false, file_id: file.id, name: file.name, error: result.error });
    }
  }

  // Code Interpreter files linked as sandbox:/mnt/data/….
  for (const [path, messageIds] of sandboxLinks(conv)) {
    const name = path.split('/').pop();
    const listed = savedSandbox.get(name.toLowerCase());
    if (listed) { record({ path: listed, kind: 'output', ok: true, sandbox_path: path, variant: 'conversation file list' }); continue; }
    let result;
    const errors = [];
    for (const messageId of [...messageIds].reverse()) {
      const url = `/backend-api/conversation/${summary.id}/interpreter/download?message_id=${encodeURIComponent(messageId)}&sandbox_path=${encodeURIComponent(path)}`;
      result = await fetchFile({ conversationId: summary.id, url, filename: name }, n => nameIn(`${folder}/outputs`, n), seen);
      if (result.ok) break;
      errors.push(result.error);
    }
    const sameName = files.find(f => f.ok && f.path && f.path.split('/').pop().toLowerCase() === name.toLowerCase());
    if (result.ok) record({ path: result.savedAs.slice(folder.length + 1), kind: 'output', ok: true, sandbox_path: path, bytes: result.bytes, verified: result.verified, duplicate: result.duplicate || undefined });
    else if (sameName) record({ path: sameName.path, kind: 'output', ok: true, sandbox_path: path, variant: 'sandbox expired; same-named file saved from the chat' });
    else record({ path: null, kind: 'output', ok: false, sandbox_path: path, error: [...new Set(errors)].join(' / ') + ' (sandbox expired or file replaced)' });
  }

  // Canvas documents: /textdocs has the final versions; otherwise replay the canmore calls.
  let docs = canvasDocs(main);
  if (Object.values(conv.mapping || {}).some(n => String(n?.message?.recipient || n?.message?.author?.name || '').startsWith('canmore.'))) {
    try {
      const textdocs = await apiJson(`/backend-api/conversation/${summary.id}/textdocs`);
      if (Array.isArray(textdocs) && textdocs.length) {
        docs = textdocs.map(d => ({ name: d.title || d.id, type: d.textdoc_type || 'document', content: String(d.content ?? ''), versions: d.version, failedUpdates: 0, source: 'textdocs' }));
      }
    } catch (error) { log(`  canvas endpoint unavailable (${error.code || error.message}); rebuilt from the chat`); }
  }
  for (const doc of docs) {
    const ext = CANVAS_EXT[doc.type] || (String(doc.type).startsWith('code/') ? '.txt' : '.md');
    const savedAs = await saveText(nameIn(`${folder}/canvas`, /\.[a-z0-9]{1,6}$/i.test(doc.name) ? doc.name : `${doc.name}${ext}`), doc.content);
    record({ path: savedAs.slice(folder.length + 1), kind: 'canvas', ok: true, versions: doc.versions, failedUpdates: doc.failedUpdates });
  }

  // Transcripts (the same renderer rebuilds them offline: scripts/chatgpt/rerender.mjs).
  const title = conv.title || summary.title || 'Untitled';
  const rendered = ArchiveRender.documents(conv, { id: summary.id, title: summary.title, project: summary.project, is_archived: summary.is_archived }, names);
  for (const [path, kind] of [['transcript.md', 'transcript'], ['chatgpt-view.md', 'view'], ['branches.md', 'branches'], ['thinking.md', 'thinking']]) {
    if (rendered[path] == null) {
      if (kind === 'view' && rendered.viewError) record({ path, kind, ok: false, error: rendered.viewError });
      continue;
    }
    await saveText(`${folder}/${path}`, rendered[path], 'text/markdown');
    record({ path, kind, ok: true, ...(kind === 'thinking' ? { blocks: rendered.thinkingBlocks } : {}) });
  }

  const fileIds = [...new Set(files.filter(f => f.ok && f.file_id).map(f => f.file_id))];
  for (const id of fileIds) savedFileIds.add(id);
  const count = kind => new Set(files.filter(f => f.kind === kind && f.ok && f.path).map(f => f.path)).size;
  const stats = {
    messages: main.length + others.length,
    thinking: rendered.thinkingBlocks,
    uploads: count('upload'),
    outputs: count('output'),
    canvas: count('canvas'),
    failed: files.filter(f => !f.ok).length,
  };
  await saveJson(`${folder}/manifest.json`, { id: summary.id, title, url: `https://chatgpt.com/c/${summary.id}`,
    created: toIso(conv.create_time), updated: toIso(conv.update_time), archived_at: new Date().toISOString(), stats, files });
  return { stats, fileIds };
}

// ── Listing ──

async function listConversations() {
  const all = new Map();
  const add = (items, extra = {}) => { for (const item of items || []) if (item?.id && !all.has(item.id)) all.set(item.id, { ...item, ...extra }); };
  // `total` is unreliable and pages can come back short: advance by what arrived, stop on empty.
  for (const [filter, extra] of [['', {}], ['&is_archived=true', { is_archived: true }], ['&is_starred=true', {}]]) {
    for (let offset = 0, pages = 0; pages < 2000; pages++) {
      const page = await apiJson(`/backend-api/conversations?offset=${offset}&limit=${LIST_LIMIT}&order=updated${filter}`);
      const items = page.items || [];
      if (!items.length) break;
      add(items, extra);
      offset += items.length;
    }
  }
  // Project chats live under their project ("snorlax" gizmo) and may not appear above.
  try {
    for (const project of await listProjects()) {
      let cursor = '0';
      for (let pages = 0; cursor != null && pages < 1000; pages++) {
        const page = await apiJson(`/backend-api/gizmos/${project.id}/conversations?cursor=${encodeURIComponent(cursor)}&limit=50`);
        add(page.items || [], { project: project.name, gizmo_id: project.id });
        for (const item of page.items || []) if (all.get(item.id) && !all.get(item.id).project) all.get(item.id).project = project.name;
        cursor = page.cursor ?? null;
        if (!(page.items || []).length) break;
      }
    }
  } catch (error) {
    log(`project chats unavailable (${error.message})`);
  }
  // Newest activity first, so a long, rate-limited run saves recent work before old chats.
  return [...all.values()].sort((a, b) => toIso(b.update_time).localeCompare(toIso(a.update_time)));
}
let projectCache = null;
async function listProjects() {
  if (projectCache) return projectCache;
  const projects = [];
  let cursor = null;
  for (let pages = 0; pages < 100; pages++) {
    const page = await apiJson(`/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const item of page.items || []) {
      const gizmo = item.gizmo?.gizmo || item.gizmo || item;
      if (gizmo?.id) projects.push({ id: gizmo.id, name: gizmo.display?.name || gizmo.name || gizmo.id, raw: item });
    }
    cursor = page.cursor ?? null;
    if (!cursor) break;
  }
  projectCache = projects;
  return projects;
}

// ── Account-level data ──

async function archiveAccount({ libraryPages = 400 } = {}) {
  const extras = [
    ['_account/memories.json', '/backend-api/memories?include_memory_entries=true'],
    ['_account/custom-instructions.json', '/backend-api/user_system_messages'],
    ['_account/me.json', '/backend-api/me'],
    ['_account/settings.json', '/backend-api/settings/user'],
    ['_account/shared-links.json', '/backend-api/shared_conversations?offset=0&limit=100&order=created'],
  ];
  for (const [path, url] of extras) {
    try { await saveJson(path, await apiJson(url)); log(`account: ${path.split('/').pop()}`); }
    catch (error) { log(`account: ${path.split('/').pop()} unavailable (${error.code || error.message})`); }
  }
  // Image library: every generated image; ones already saved with their chat are skipped.
  try {
    const nameIn = makeNamer();
    const index = [];
    let cursor = null;
    for (let pages = 0; pages < libraryPages && !stopRequested; pages++) {
      const page = await apiJson(`/backend-api/my/recent/image_gen?limit=25${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
      for (const item of page.items || []) {
        const id = fileIdOf(item.url) || fileIdOf(item.id);
        const entry = { id: item.id, file_id: id, conversation_id: item.conversation_id, title: item.title, created_at: item.created_at };
        if (id && savedFileIds.has(id)) { index.push({ ...entry, status: 'saved with its chat' }); continue; }
        const result = await fetchFile({ conversationId: item.conversation_id || null, url: item.url, filename: `${safeSegment(item.title || 'image', 'image', 60)} ${String(item.id).slice(-8)}` },
          n => nameIn('_image-library', n));
        index.push({ ...entry, status: result.ok ? 'saved' : 'failed', path: result.savedAs, error: result.error });
      }
      cursor = page.cursor ?? null;
      if (!cursor || !(page.items || []).length) break;
    }
    await saveJson('_image-library/_index.json', index);
    log(`image library: ${index.length} images (${index.filter(e => e.status === 'saved').length} not already in a chat folder)`);
  } catch (error) {
    log(`image library unavailable (${error.code || error.message})`);
  }
  // Projects: instructions, settings and their files.
  try {
    for (const project of await listProjects()) await archiveProject(project);
  } catch (error) {
    log(`projects unavailable (${error.message})`);
  }
}

// One project ("snorlax" gizmo): project.json (settings), instructions.md and its files.
const projectFolder = project => `_projects/${safeSegment(project.name, project.id, 70)} [${project.id.slice(-8)}]`;
async function archiveProject(project) {
  const folder = projectFolder(project);
  const nameIn = makeNamer();
  let detail = project.raw || null;
  try { detail = await apiJson(`/backend-api/gizmos/${project.id}`); } catch (error) { if (!detail) log(`  project details unavailable (${error.code || error.message})`); }
  await saveJson(`${folder}/project.json`, detail || { id: project.id, name: project.name });
  const gizmo = detail?.gizmo || detail;
  const instructions = gizmo?.instructions;
  if (typeof instructions === 'string' && instructions.trim()) await saveText(`${folder}/instructions.md`, instructions, 'text/markdown');
  let saved = 0, failed = 0;
  for (const file of detail?.files || gizmo?.files || []) {
    const id = fileIdOf(file.file_id || file.id);
    if (!id) continue;
    const result = await fetchFile({ conversationId: null, id, filename: file.name || id, expectedSize: file.size,
      url: `/backend-api/files/download/${id}?gizmo_id=${encodeURIComponent(project.id)}` }, n => nameIn(`${folder}/files`, n));
    if (result.ok) saved++; else { failed++; log(`  project file failed: ${file.name || id} (${result.error})`); }
  }
  log(`project: ${project.name} (${saved} files${failed ? `, ${failed} failed` : ''})`);
  return folder;
}

// Chats of one project, newest first.
async function listProjectConversations(project) {
  const chats = [];
  let cursor = '0';
  for (let pages = 0; cursor != null && pages < 1000; pages++) {
    const page = await apiJson(`/backend-api/gizmos/${project.id}/conversations?cursor=${encodeURIComponent(cursor)}&limit=50`);
    for (const item of page.items || []) if (item?.id) chats.push({ ...item, project: project.name, gizmo_id: project.id });
    cursor = page.cursor ?? null;
    if (!(page.items || []).length) break;
  }
  return chats.sort((a, b) => toIso(b.update_time).localeCompare(toIso(a.update_time)));
}
async function findProject(id) {
  const projects = await listProjects().catch(() => []);
  return projects.find(p => p.id === id) || { id, name: id };
}
const PROJECT_ID = /g-p-[0-9a-f]{32}/i;
const projectIdOf = conv => [conv?.gizmo_id, conv?.conversation_template_id].map(v => String(v || '').match(PROJECT_ID)?.[0]).find(Boolean) || null;

// ── Run orchestration ──

let heartbeatPending = false;
function scheduleHeartbeat() {
  if (heartbeatPending) return;
  heartbeatPending = true;
  sleep(15000).then(async () => { try { await writeStatus(); } finally { heartbeatPending = false; } });
}
let statusWriting = null;
let statusDirty = false;
async function writeStatus(extra = {}) {
  Object.assign(status, extra, { updated_at: new Date().toISOString() });
  if (statusWriting) { statusDirty = true; return statusWriting; }
  statusWriting = (async () => {
    els['progress-fill'].style.width = `${status.total ? Math.round((100 * status.processed) / status.total) : 0}%`;
    els.summary.textContent = `${status.phase} · ${status.processed}/${status.total || '?'} chats · ${status.archived} archived, ${status.skipped} unchanged, ${status.failed} failed`;
    try { await saveJson(status.mode === 'account' ? '_status-account.json' : '_status.json', status); } catch (error) { console.warn(LOG_PREFIX, 'status write failed', error); }
    mirrorStatus();
  })();
  try { await statusWriting; } finally { statusWriting = null; }
  if (statusDirty) { statusDirty = false; await writeStatus(); }
}
// The toolbar popup shows the latest run from here (it cannot read Downloads).
let pageTabId = null;
chrome.tabs.getCurrent().then(tab => { pageTabId = tab?.id ?? null; });
function mirrorStatus() {
  const { log: _log, errors, ...rest } = status;
  chrome.storage.local.set({ 'backup-status:chatgpt': { ...rest, errors: errors.length, tabId: pageTabId, last_log: status.log.at(-1) || '' } }).catch(() => {});
}
async function loadState() {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
  return stored[rootDir] || { done: {} };
}
// archive-state.json (optional, git-ignored, next to manifest.json) seeds the finished-chat
// record — e.g. when a run moves to another computer together with its archive folder.
// Written by scripts/seed-from-archive.py from an archive folder's manifests.
async function loadSeed() {
  try {
    const response = await fetch(chrome.runtime.getURL('chatgpt/archive-state.json'));
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
async function saveState(state) {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
  stored[rootDir] = state;
  await chrome.storage.local.set({ [STATE_KEY]: stored });
}
function renderIndex(rows) {
  const lines = ['# ChatGPT full archive', '', `Generated ${new Date().toISOString()} · ${rows.length} chats`, '',
    '| Date | Chat | Msgs | Thinking | Uploads | Outputs | Canvas | Failed |', '|---|---|---|---|---|---|---|---|'];
  for (const row of rows) {
    const s = row.stats || {};
    const title = String(row.title || 'Untitled').replace(/\|/g, '\\|');
    const link = row.folder ? `[${title}](${mdLink(`${row.folder}/transcript.md`)})` : `${title} (failed: ${row.error})`;
    lines.push(`| ${isoDate(row.create_time)} | ${link} | ${s.messages ?? ''} | ${s.thinking ?? ''} | ${s.uploads ?? ''} | ${s.outputs ?? ''} | ${s.canvas ?? ''} | ${s.failed ?? ''} |`);
  }
  return `${lines.join('\n')}\n`;
}

// redo: chats to archive again even though they are recorded as finished (e.g. after a fix).
// project: a project (gizmo) ID — archive that project's chats and the project itself.
async function run({ ids = null, force = false, redo = [], project = null }) {
  stopRequested = false;
  rootDir = safeSegment(els.root.value || DEFAULT_ROOT, DEFAULT_ROOT);
  const mode = project ? 'project' : ids ? 'selected' : 'all';
  status = { root: rootDir, mode, phase: 'starting', started_at: new Date().toISOString(), total: 0, processed: 0, archived: 0, skipped: 0, failed: 0, current: null, errors: [], log: [] };
  setRunning(true);
  log(`Archiving into Downloads/${rootDir}/ ${project ? `(project ${project})` : ids ? `(${ids.length} selected chats)` : '(every chat)'}`);
  await writeStatus({ phase: 'listing' });
  const state = await loadState();
  const seed = await loadSeed();
  if (seed?.root === rootDir && seed.done && typeof seed.done === 'object') {
    let added = 0;
    for (const [id, entry] of Object.entries(seed.done)) if (!state.done[id]) { state.done[id] = entry; added++; }
    if (added) { await saveState(state); log(`Seeded ${added} finished chats from archive-state.json`); }
  }
  const rows = [];
  try {
    let conversations;
    const prefetched = new Map();
    const projectIds = new Set();
    if (project) {
      const info = await findProject(project);
      projectIds.add(info.id);
      conversations = await listProjectConversations(info);
      log(`${conversations.length} chats in project ${info.name}`);
    } else if (ids) {
      // Selected chats: fetch them directly instead of spending rate-limit budget on the full list.
      conversations = [];
      for (const id of ids) {
        try {
          const conv = await apiJson(`/backend-api/conversation/${id}`);
          prefetched.set(id, conv);
          const summary = { id, title: conv.title, create_time: conv.create_time, update_time: conv.update_time, is_archived: conv.is_archived };
          // Project chats: name the project in the transcript and save the project folder too.
          const gizmoId = projectIdOf(conv);
          if (gizmoId) {
            const info = await findProject(gizmoId);
            Object.assign(summary, { project: info.name, gizmo_id: info.id });
            projectIds.add(info.id);
          }
          conversations.push(summary);
          // Rate-limited to about one a minute, so show progress (and keep the heartbeat fresh).
          log(`fetched ${prefetched.size} / ${ids.length}: ${conv.title || id.slice(0, 8)}`);
        } catch (error) {
          rows.push({ id, folder: null, error: error.message });
          log(`  ✗ ${id.slice(0, 8)}: ${error.message}`);
        }
      }
    } else {
      conversations = await listConversations();
      log(`${conversations.length} chats listed (${conversations.filter(c => c.is_archived).length} archived, ${conversations.filter(c => c.project).length} in projects)`);
      await saveJson('_conversations.json', conversations);
    }
    status.total = conversations.length;
    await writeStatus({ phase: 'archiving' });
    for (const summary of conversations) {
      if (stopRequested) break;
      const known = state.done[summary.id];
      const folder = known?.folder || `${isoDate(summary.create_time)} ${safeSegment(summary.title, 'Untitled', 70)} [${summary.id.slice(0, 8)}]`;
      const row = { id: summary.id, title: summary.title, create_time: summary.create_time, folder };
      status.current = summary.title;
      if (!force && known && !redo.includes(summary.id) && known.rev === ARCHIVE_REVISION && toIso(known.update_time) === toIso(summary.update_time)) {
        row.stats = known.stats;
        for (const id of known.fileIds || []) savedFileIds.add(id);
        status.skipped++;
      } else {
        try {
          log(`▶ ${summary.title || 'Untitled'} [${summary.id.slice(0, 8)}]`);
          const result = await archiveConversation(summary, folder, prefetched.get(summary.id));
          prefetched.delete(summary.id);
          row.stats = result.stats;
          const s = row.stats;
          log(`  ✓ ${s.messages} msgs · ${s.thinking} thinking · ${s.uploads} uploads · ${s.outputs} outputs · ${s.canvas} canvas${s.failed ? ` · ${s.failed} FAILED` : ''}`);
          state.done[summary.id] = { update_time: summary.update_time, folder, stats: s, fileIds: result.fileIds, rev: ARCHIVE_REVISION };
          await saveState(state);
          status.archived++;
        } catch (error) {
          if (error.code === 'AUTH_WAITING' || error.code === 'AUTH_EXPIRED') throw error;
          row.folder = null;
          row.error = error.message;
          status.failed++;
          status.errors.push({ id: summary.id, title: summary.title, error: error.message });
          log(`  ✗ ${error.message}`);
        }
      }
      rows.push(row);
      status.processed++;
      await writeStatus();
    }
    if ((ids || project) && projectIds.size && !stopRequested) {
      await writeStatus({ phase: 'projects' });
      for (const id of projectIds) {
        try { await archiveProject(await findProject(id)); }
        catch (error) { log(`project ${id} failed: ${error.message}`); status.errors.push({ project: id, error: error.message }); }
      }
    }
    if (!ids && !project && !stopRequested) {
      await writeStatus({ phase: 'account' });
      await archiveAccount();
      await saveText('_index.md', renderIndex(rows), 'text/markdown');
      await saveJson('_index.json', rows);
    }
    await writeStatus({ phase: stopRequested ? 'stopped' : 'done', current: null });
    log(stopRequested ? 'Stopped. Run again to resume.' : 'Done.');
  } catch (error) {
    status.errors.push({ fatal: true, error: error.message });
    log(`FATAL: ${error.message}`);
    await writeStatus({ phase: 'error' });
  } finally {
    setRunning(false);
    closeWorkerTab();
  }
}

// Account-level data only (memories, instructions, settings, shared links, image library, projects).
async function runAccount({ libraryPages }) {
  rootDir = safeSegment(els.root.value || DEFAULT_ROOT, DEFAULT_ROOT);
  status = { root: rootDir, mode: 'account', phase: 'account', started_at: new Date().toISOString(), total: 0, processed: 0, archived: 0, skipped: 0, failed: 0, errors: [], log: [] };
  setRunning(true);
  try { await archiveAccount({ libraryPages }); await writeStatus({ phase: 'done' }); }
  catch (error) { log(`FATAL: ${error.message}`); await writeStatus({ phase: 'error' }); }
  finally { setRunning(false); closeWorkerTab(); }
}

// Saves raw responses for a list of backend paths under _probe/, so API shapes can be inspected.
async function probe(paths) {
  rootDir = safeSegment(els.root.value || DEFAULT_ROOT, DEFAULT_ROOT);
  const summary = [];
  for (const [i, path] of paths.entries()) {
    const result = path.startsWith('raw:') ? await pageCall('inspectUrl', [path.slice(4)]) : await pageCall('json', [path]);
    const body = result.ok ? result.value : { code: result.code, message: result.message };
    const items = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : null;
    summary.push({ path, ok: result.ok, code: result.code, count: items?.length, total: body?.total });
    await saveJson(`_probe/${String(i + 1).padStart(2, '0')}.json`, { path, ok: result.ok, body });
    log(`probe ${result.ok ? 'ok' : result.code} ${path}${items ? ` (${items.length} items)` : ''}`);
  }
  await saveJson('_probe/_summary.json', summary);
  closeWorkerTab();
}

function setRunning(running) {
  els['run-all'].disabled = running;
  els['run-some'].disabled = running;
  els['load-list'].disabled = running;
  els.stop.disabled = !running;
}
const idsFrom = text => [...new Set(String(text || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])];
els['run-all'].addEventListener('click', () => run({ force: els.force.checked }));
els['run-some'].addEventListener('click', () => {
  const ids = idsFrom(els.ids.value);
  if (ids.length) run({ ids, force: els.force.checked });
  else log('Paste one or more chat links or IDs first.');
});
els.stop.addEventListener('click', () => { stopRequested = true; log('Stopping after the current chat…'); });

// ── Choose chats: load the chat list, filter it, tick chats into the "Only these chats" box ──

let pickerChats = [];
function pickedIds() { return new Set(idsFrom(els.ids.value)); }
function setPicked(id, on) {
  const lines = els.ids.value.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !l.includes(id));
  if (on) lines.push(`https://chatgpt.com/c/${id}`);
  els.ids.value = lines.join('\n');
  els['picked-count'].textContent = `${pickedIds().size} chosen`;
}
function renderPicker() {
  const query = els.filter.value.trim().toLowerCase();
  const picked = pickedIds();
  const shown = pickerChats.filter(c => !query || `${c.title || ''} ${c.project || ''}`.toLowerCase().includes(query));
  els['chat-list'].replaceChildren(...shown.slice(0, 1500).map(chat => {
    const row = document.createElement('label');
    row.className = 'chat-row';
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: picked.has(chat.id) });
    box.dataset.id = chat.id;
    box.addEventListener('change', () => setPicked(chat.id, box.checked));
    const title = Object.assign(document.createElement('span'), { className: 'chat-title', textContent: chat.title || 'Untitled' });
    const meta = Object.assign(document.createElement('span'), { className: 'chat-meta',
      textContent: [isoDate(chat.update_time), chat.project ? `project: ${chat.project}` : '', chat.is_archived ? 'archived' : ''].filter(Boolean).join(' · ') });
    row.append(box, title, meta);
    return row;
  }));
  els['picked-count'].textContent = `${picked.size} chosen · ${shown.length} shown${shown.length > 1500 ? ' (first 1500 listed)' : ''}`;
}
async function loadPicker() {
  els['load-list'].disabled = true;
  els['load-list'].textContent = 'Loading…';
  try {
    log('Loading the chat list…');
    pickerChats = await listConversations();
    log(`${pickerChats.length} chats loaded. Tick chats, then "Archive listed chats".`);
    renderPicker();
  } catch (error) {
    log(`Could not load the chat list: ${error.message}`);
  } finally {
    els['load-list'].disabled = false;
    els['load-list'].textContent = 'Reload list';
  }
}
els['load-list'].addEventListener('click', loadPicker);
els.filter.addEventListener('input', renderPicker);
els['select-shown'].addEventListener('click', () => {
  for (const box of els['chat-list'].querySelectorAll('input[type=checkbox]')) if (!box.checked) { box.checked = true; setPicked(box.dataset.id, true); }
  renderPicker();
});
els['select-none'].addEventListener('click', () => { els.ids.value = ''; renderPicker(); });
chrome.tabs.getCurrent().then(tab => { if (tab) chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {}); });

// Automation: archive.html?auto=1&root=…&ids=a,b&force=1, or &probe=path|path
if (params.get('root')) els.root.value = params.get('root');
if (params.get('ids')) els.ids.value = params.get('ids').split(',').join('\n');
if (params.get('force') === '1') els.force.checked = true;
if (params.get('probe')) probe(params.get('probe').split('|').filter(Boolean));
else if (params.get('account') === '1') runAccount({ libraryPages: Number(params.get('libraryPages')) || 400 });
else if (params.get('auto') === '1') {
  const ids = idsFrom(params.get('ids'));
  const project = params.get('project')?.match(PROJECT_ID)?.[0] || null;
  run({ ids: ids.length ? ids : null, force: params.get('force') === '1', redo: idsFrom(params.get('redo')), project });
} else if (params.get('pick') === '1') {
  document.getElementById('picker').open = true;
  loadPicker();
}
