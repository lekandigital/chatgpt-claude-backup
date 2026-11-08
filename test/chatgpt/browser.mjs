// Optional integration test using actual Chromium + the built unpacked extension.
// No real ChatGPT account, profile or network is used: chatgpt.com is answered by Playwright
// routes, and the storage host by a local TLS server behind a proxy that refuses every other host.
// The storage host is real HTTP (not a Playwright route) because routes skip CORS checks and are
// not applied to redirect targets — both of which this test needs to exercise genuinely.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
let playwright;
try { playwright = await import('playwright'); }
catch {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error('Run npm install, then npx playwright install chromium.');
  playwright = await import(pathToFileURL(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright/index.mjs')).href);
}
const root = fileURLToPath(new URL('../..', import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), 'cad-browser-fixture-'));
const results = path.join(root, 'test-results');
await mkdir(results, { recursive: true });
const extension = root;
const STORAGE = 'files.oaiusercontent.com';
// Throwaway certificate for the local storage host; trusted only through ignoreHTTPSErrors below.
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${STORAGE}`,
  '-addext', `subjectAltName=DNS:${STORAGE}`, '-keyout', path.join(profile, 'key.pem'), '-out', path.join(profile, 'cert.pem')], { stdio: 'ignore' });
const storageHits = [];
let storage, proxy, context;
try {
  const pdf = '%PDF-1.7\nfixture PDF content\n%%EOF';
  storage = https.createServer({ key: await readFile(path.join(profile, 'key.pem')), cert: await readFile(path.join(profile, 'cert.pem')) }, (req, res) => {
    storageHits.push({ url: `https://${STORAGE}${req.url}`, headers: req.headers });
    const pathname = new URL(req.url, `https://${STORAGE}`).pathname;
    // No CORS header: page fetches fail, but Chrome itself can download the forced attachment.
    if (pathname === '/locked.bin') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="locked.bin"' }); res.end('LOCK'); return; }
    res.writeHead(200, { 'content-type': 'application/pdf', 'access-control-allow-origin': '*' }); res.end(pdf);
  });
  proxy = http.createServer((req, res) => { res.writeHead(403); res.end(); });
  storage.on('tlsClientError', () => {});
  proxy.on('connect', (req, socket, head) => {
    // Chrome drops idle tunnels at will; that is not a test failure.
    socket.on('error', () => {});
    if (req.url !== `${STORAGE}:443`) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    storage.emit('connection', socket);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  context = await playwright.chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, acceptDownloads: true, ignoreHTTPSErrors: true,
    proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    ...(process.env.CAD_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CAD_CHROMIUM_EXECUTABLE } : {}),
  });
  const requests = [], pageErrors = [], downloads = [];
  const files = [
    { id: 'file_direct', filename: 'direct.pdf' },
    { id: 'file_two_stage', filename: 'deck.pdf' },
    { id: 'file_html', filename: 'bad.pdf' },
    { id: 'file_json', filename: 'notes.json' },
    { id: 'file_jsonl', filename: 'transcript.jsonl' },
    { id: 'file_dup1', filename: 'same.txt' },
    { id: 'file_dup2', filename: 'same.txt' },
    { id: 'file_session', filename: 'session-notes.txt' },
    { id: 'file_redirect', filename: 'moved.pdf' },
    { id: 'file_cors', filename: 'locked.bin' },
    { id: 'file_page', filename: 'report.html' },
    { id: 'file_err', filename: 'data.csv' },
  ];
  const page = '<!DOCTYPE html><html><body>An exported page the user attached</body></html>';
  const locked = 'https://files.oaiusercontent.com/locked.bin?rscd=attachment%3B%20filename%3Dlocked.bin&sig=SIGNED_FIXTURE';
  const message = (role, parts, extra = {}) => ({ author: { role }, recipient: 'all', create_time: 1793200000, content: { content_type: 'text', parts }, ...extra });
  const conversation = { title: 'Fixture chat', create_time: 1793200000, update_time: 1793200100, current_node: 'a1', mapping: {
    root: { id: 'root', parent: null, children: ['u1'], message: null },
    u1: { id: 'u1', parent: 'root', children: ['a1'], message: message('user', ['Please review the deck.'], { metadata: { attachments: [{ id: 'file_direct', name: 'direct.pdf', mime_type: 'application/pdf' }] } }) },
    a1: { id: 'a1', parent: 'u1', children: [], message: message('assistant', ['The deck looks good.']) },
  } };
  const jsonBody = JSON.stringify({ contents: 'ordinary attachment', number: 42 });
  const jsonlBody = '{"line":1}\n{"line":2}\n';
  let hold = false;
  await context.route('https://chatgpt.com/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    requests.push({ url: request.url(), headers: request.headers() });
    const fulfill = (body, contentType = 'application/octet-stream', extra = {}) => route.fulfill({ status: 200, body, contentType, ...extra });
    if (url.origin === 'https://chatgpt.com') {
      if (url.pathname === '/fixture.js') return fulfill(`fetch('/backend-api/me',{headers:{Authorization:'Bearer SYNTHETIC_BROWSER_ONLY','oai-device-id':'FIXTURE_DEVICE'}});`, 'application/javascript');
      if (url.pathname === '/backend-api/me') return fulfill('{}', 'application/json');
      if (url.pathname.includes('/conversations/')) return fulfill(JSON.stringify({ files, has_more: false }), 'application/json');
      if (url.pathname === '/backend-api/conversation/fixture-A') return fulfill(JSON.stringify(conversation), 'application/json');
      if (url.pathname.includes('/files/download/file_two_stage')) return fulfill(JSON.stringify({
        download_url: 'https://files.oaiusercontent.com/fixture.pdf?sig=SIGNED_FIXTURE', file_name: 'real-deck.pdf', file_size_bytes: Buffer.byteLength(pdf),
      }), 'application/json');
      if (url.pathname.includes('/files/download/file_html')) return fulfill('<!DOCTYPE html><html>ChatGPT shell</html>', 'text/html');
      // A plain HTTP redirect from ChatGPT to storage: must not carry account headers along.
      if (url.pathname.includes('/files/download/file_redirect')) return route.fulfill({ status: 302, headers: { location: 'https://files.oaiusercontent.com/redirected.pdf?sig=SIGNED_FIXTURE' } });
      if (url.pathname.includes('/files/download/file_cors')) return fulfill(JSON.stringify({ download_url: locked, file_name: 'locked.bin', file_size_bytes: 4 }), 'application/json');
      if (url.pathname.includes('/files/download/file_page')) return fulfill(JSON.stringify({
        download_url: '/backend-api/estuary/content?id=file_page&sig=SIGNED_FIXTURE', file_name: 'report.html', file_size_bytes: Buffer.byteLength(page) }), 'application/json');
      if (url.pathname === '/backend-api/estuary/content') return fulfill(page, 'text/html');
      if (url.pathname.includes('/files/download/file_err')) return fulfill(JSON.stringify({ detail: 'File not found' }), 'application/json');
      if (url.pathname.includes('/files/download/file_jsonl')) return fulfill(jsonlBody, 'application/jsonl');
      if (url.pathname.includes('/files/download/file_json')) return fulfill(jsonBody, 'application/json');
      if (url.pathname.includes('/files/download/file_direct')) {
        if (hold) return route.fulfill({ status: 429, headers: { 'retry-after': '30' }, body: '' });
        return fulfill(pdf, 'application/pdf');
      }
      if (url.pathname.includes('/files/download/')) return fulfill('plain attachment', 'text/plain');
      if (url.pathname.startsWith('/c/')) return fulfill('<!doctype html><html><head><title>Attachment fixture - ChatGPT</title><script src="/fixture.js" defer></script></head><body><h1>Test conversation</h1></body></html>', 'text/html', {
        headers: { 'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self' https://files.oaiusercontent.com; style-src 'none'" },
      });
    }
    throw new Error(`Unexpected fixture request to ${url.pathname}`);
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const chat = await context.newPage(); chat.on('pageerror', error => pageErrors.push(error.message));
  chat.on('download', download => downloads.push(download));
  await chat.goto('https://chatgpt.com/c/fixture-A');
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://chatgpt.com/c/fixture-A' }))[0].id);
  async function status() {
    return worker.evaluate(async id => chrome.tabs.sendMessage(id, { type: 'PAGE_COMMAND', command: { type: 'GET_STATUS' } }, { frameId: 0 }), tabId);
  }
  async function waitFor(check, label) {
    const deadline = Date.now() + 90000;
    let last = null;
    while (Date.now() < deadline) { const result = await status(); last = result.state; if (check(result.state)) return result.state; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`${label}: ${JSON.stringify({ scan: last?.scan, batch: last?.batch, error: last?.error, files: last?.files.map(f => [f.id, f.status, f.error?.code]) })}`);
  }
  async function openPopup() {
    const popup = await context.newPage(); popup.on('pageerror', error => pageErrors.push(error.message));
    // Keep the fixture as active tab; extension pages opened in tabs otherwise select themselves.
    await worker.evaluate(async id => chrome.tabs.update(id, { active: true }), tabId);
    await popup.goto(`chrome-extension://${extensionId}/chatgpt/popup/popup.html`);
    await popup.locator('#auth').filter({ hasText: 'Auth ready' }).waitFor();
    return popup;
  }
  await waitFor(state => state.auth.detected, 'Authentication not observed at document_start');
  let popup = await openPopup();
  await popup.locator('#scan').click();
  await waitFor(state => state.scan.fresh && state.files.length === files.length, 'Scan failed');
  await popup.locator('#file-list .file-row').first().waitFor();
  await popup.screenshot({ path: path.join(results, 'popup-light.png') });
  await popup.emulateMedia({ colorScheme: 'dark' });
  await popup.waitForTimeout(400); // let the 120 ms button background transition finish
  await popup.screenshot({ path: path.join(results, 'popup-dark.png') });
  const secondary = await popup.evaluate(() => getComputedStyle(document.getElementById('scan')).backgroundColor);
  assert.notEqual(secondary, 'rgb(255, 255, 255)', 'dark-mode secondary buttons must not be white');
  await popup.emulateMedia({ colorScheme: 'light' });
  // The multiple-downloads notice is acknowledged by starting the first batch.
  assert.equal(await popup.locator('#notice').isVisible(), true);
  await popup.locator('#download-all').click();
  await popup.locator('#notice').waitFor({ state: 'hidden' });
  await popup.close();
  const done = await waitFor(state => state.batch.status === 'completed', 'Batch did not complete with popup closed');
  assert.equal(done.error, null, 'per-file failures belong on their rows, not the banner');
  const byId = id => done.files.find(f => f.id === id);
  if (process.env.CAD_DEBUG) console.log(JSON.stringify(done.files.map(f => [f.id, f.status, f.error?.code, f.delivery])));
  assert.equal(done.files.filter(f => f.status === 'downloaded').length, 10);
  assert.equal(byId('file_html').error.code, 'HTML_RESPONSE');
  assert.equal(byId('file_err').error.code, 'SERVER_ERROR');
  assert.equal(byId('file_cors').delivery, 'link');
  assert.equal(byId('file_page').verified, true);
  await new Promise(r => setTimeout(r, 1000));
  // Ten attachments, then the Markdown transcript ("Include transcript" is on by default).
  assert.equal(downloads.length, 11);
  const filenames = downloads.map(d => d.suggestedFilename());
  assert.equal(new Set(filenames).size, 11);
  assert.equal(filenames.at(-1), 'Fixture chat (transcript).md');
  assert.equal(done.transcript.status, 'saved'); assert.equal(done.transcript.messages, 2);
  for (const name of ['real-deck.pdf', 'session-notes.txt', 'moved.pdf', 'locked.bin', 'report.html']) assert.ok(filenames.includes(name), name);
  for (const name of ['bad.pdf', 'data.csv', 'deck.pdf']) assert.ok(!filenames.includes(name), name);
  for (const download of downloads) {
    assert.equal(await download.failure(), null);
    const bytes = await readFile(await download.path());
    if (download.suggestedFilename().endsWith('.pdf')) assert.equal(bytes.toString(), pdf);
    if (download.suggestedFilename() === 'notes.json') assert.equal(bytes.toString(), jsonBody);
    if (download.suggestedFilename() === 'transcript.jsonl') assert.equal(bytes.toString(), jsonlBody);
    if (download.suggestedFilename() === 'report.html') assert.equal(bytes.toString(), page);
    if (download.suggestedFilename() === 'locked.bin') assert.equal(bytes.toString(), 'LOCK');
    if (download.suggestedFilename().endsWith('(transcript).md')) {
      const markdown = bytes.toString();
      for (const part of ['# Fixture chat', '### You', 'Please review the deck.', '- 📎 [direct.pdf](<direct.pdf>)', '### ChatGPT', 'The deck looks good.']) assert.ok(markdown.includes(part), part);
    }
  }
  const external = storageHits;
  assert.ok(external.some(r => r.url.includes('/redirected.pdf')), 'redirect was not followed');
  assert.ok(external.filter(r => r.url.includes('/locked.bin')).length >= 2, 'CORS refusal then Chrome download expected');
  for (const request of external) for (const header of ['authorization', 'oai-device-id', 'cookie', 'referer']) {
    assert.equal(request.headers[header], undefined, `${header} sent to ${new URL(request.url).pathname}`);
  }
  popup = await openPopup();
  await popup.setViewportSize({ width: 420, height: 900 });
  await popup.screenshot({ path: path.join(results, 'popup-completed.png'), fullPage: true });
  // The JSON transcript is the API response, equal once parsed.
  const jsonDownload = chat.waitForEvent('download');
  await popup.locator('#transcript-json').click();
  const transcriptJson = await jsonDownload;
  assert.equal(transcriptJson.suggestedFilename(), 'Fixture chat (transcript).json');
  assert.deepEqual(JSON.parse(await readFile(await transcriptJson.path(), 'utf8')), conversation);
  await popup.locator('#transcript-status').filter({ hasText: 'Transcript saved · 2 messages (JSON)' }).waitFor();
  await popup.close();
  popup = await openPopup();
  await popup.locator('#phase').filter({ hasText: 'Completed' }).waitFor();
  // Deliberate redownload, then stop while Retry-After is active.
  hold = true;
  await popup.locator('#select-file_direct').check(); await popup.locator('#download-selected').click();
  await waitFor(state => state.waiting === 'rate_limit', 'Rate-limit state missing');
  await popup.locator('#stop').click(); await waitFor(state => state.batch.status === 'stopped', 'Stop failed');
  hold = false;
  await popup.close();
  await chat.evaluate(() => history.pushState({}, '', '/c/fixture-B'));
  const navigated = await waitFor(state => state.conversationId === 'fixture-B', 'SPA change not detected');
  assert.equal(navigated.files.length, 0); assert.equal(navigated.scan.fresh, false);
  await chat.goto('https://chatgpt.com/c/fixture-A');
  await waitFor(state => state.auth.detected && !state.scan.fresh, 'Reload did not reset auth/scan');
  popup = await openPopup(); await popup.locator('#scan').click();
  const restored = await waitFor(state => state.scan.fresh, 'Rescan failed');
  assert.ok(restored.files.some(f => f.status === 'downloaded'));
  const saved = await worker.evaluate(() => chrome.storage.local.get(null));
  const serialized = JSON.stringify(saved);
  for (const secret of ['SYNTHETIC_BROWSER_ONLY', 'FIXTURE_DEVICE', 'SIGNED_FIXTURE', 'Bearer', 'authorization', 'download_url']) assert.ok(!serialized.includes(secret));
  assert.deepEqual(pageErrors, []);
  console.log('Chromium fixture passed: manifest load, real messaging, popup, CSP, byte downloads, popup closure, stop/backoff, SPA, persistence, header scoping.');
} finally {
  await context?.close();
  proxy?.close(); storage?.close();
  await rm(profile, { recursive: true, force: true });
}
