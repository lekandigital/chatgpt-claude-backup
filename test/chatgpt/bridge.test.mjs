// Runs the shipped MAIN, isolated content script and worker in separate JS realms.
// Browser APIs are simulated here; real Chromium coverage is in browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { until, json } from './helpers.mjs';

async function fixture() {
  const base = ['core/config.js', 'core/safety.js', 'core/protocol.js'];
  async function code(parts) {
    return `(function(){'use strict';\n${(await Promise.all(parts.map(p => readFile(new URL(`../../src/chatgpt/${p}`, import.meta.url), 'utf8')))).join('\n')}\n})();`;
  }
  const mainCode = await code([...base, 'core/endpoints.js', 'core/auth.js', 'core/transfer.js', 'core/files.js', 'core/transcript.js', 'core/controller.js', 'main-world.js']);
  const contentCode = await code([...base, 'content.js']);
  const workerCode = await code([...base, 'service-worker.js']);
  const pageEvents = new Map(), contentEvents = new Map();
  const store = {}, network = [], posted = [], downloads = [], logs = [];
  const extensionId = 'fixture-extension';
  const timers = new Set(), intervals = new Set();
  let workerListener, contentListener;
  let location = new URL('https://chatgpt.com/c/A');
  let alive = true;
  const setup = {
    URL, Request, Headers, Response, Blob, TextEncoder, TextDecoder, AbortController, DOMException, crypto: webcrypto,
    console: { error: (...args) => logs.push(args) }, structuredClone,
    setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); if (alive) fn(); }, ms); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    setInterval(fn, ms) { const timer = setInterval(() => { if (alive) fn(); }, ms); intervals.add(timer); return timer; },
    clearInterval(timer) { clearInterval(timer); intervals.delete(timer); },
  };
  const urlClass = class extends URL {};
  urlClass.createObjectURL = blob => { const id = `blob:fixture-${downloads.length}`; downloads.push({ blob, id }); return id; };
  urlClass.revokeObjectURL = () => {};
  const document = {
    title: 'Fixture - ChatGPT',
    body: { appendChild() {} },
    createElement() { return { remove() {}, click() { downloads[downloads.length - 1].filename = this.download; } }; },
  };
  function add(map, type, listener) { const list = map.get(type) || []; list.push(listener); map.set(type, list); }
  const win = { fetch: async (url, init) => {
    network.push({ url: String(url), init });
    if (String(url).includes('/conversations/')) return json({ files: [{ id: 'file_one', name: 'note.txt' }] });
    return new Response('attachment bytes');
  } };
  win.top = win;
  win.addEventListener = (type, listener) => add(pageEvents, type, listener);
  win.postMessage = (message, origin) => {
    posted.push(structuredClone(message));
    queueMicrotask(() => {
      for (const listener of pageEvents.get('message') || []) listener({ source: win, origin, data: structuredClone(message) });
      for (const listener of contentEvents.get('message') || []) listener({ source: contentWindow, origin, data: structuredClone(message) });
    });
  };
  const contentWindow = { postMessage: win.postMessage, addEventListener: (type, listener) => add(contentEvents, type, listener) };
  const history = {
    pushState(data, unused, path) { location = new URL(path, location); },
    replaceState(data, unused, path) { location = new URL(path, location); },
  };
  const storage = {
    async get(keys) {
      if (keys === null) return structuredClone(store);
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) if (key in store) result[key] = structuredClone(store[key]);
      return result;
    },
    async set(values) { Object.assign(store, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; },
  };
  const sender = () => ({ id: extensionId, frameId: 0, tab: { id: 1 }, url: location.href });
  const popupSender = { id: extensionId, url: `chrome-extension://${extensionId}/chatgpt/popup/popup.html` };
  const workerChrome = {
    storage: { local: storage },
    runtime: { id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`, onMessage: { addListener: fn => { workerListener = fn; } } },
    tabs: { query: async () => [{ id: 1, url: location.href }], get: async () => ({ id: 1, url: location.href }),
      sendMessage: async (id, message) => new Promise(resolve => contentListener(structuredClone(message), { id: extensionId }, resolve)), reload: async () => {} },
  };
  const contentChrome = {
    runtime: { id: extensionId, onMessage: { addListener: fn => { contentListener = fn; } },
      sendMessage: message => new Promise(resolve => workerListener(structuredClone(message), sender(), resolve)) },
  };
  const mainContext = vm.createContext({ ...setup, URL: urlClass, window: win, document, history, get location() { return location; } });
  const contentContext = vm.createContext({ ...setup, window: contentWindow, chrome: contentChrome, get location() { return location; } });
  const workerContext = vm.createContext({ ...setup, chrome: workerChrome });
  vm.runInContext(workerCode, workerContext);
  vm.runInContext(mainCode, mainContext);
  vm.runInContext(contentCode, contentContext);
  const popup = message => new Promise(resolve => workerListener(message, popupSender, resolve));
  const command = (type, extras = {}) => popup({ type: 'UI_COMMAND', tabId: 1, command: { type, conversationId: location.pathname.split('/').pop(), ...extras } });
  await until(() => posted.some(p => p.type === 'REPLY'));
  return { win, store, downloads, posted, logs, network, popup, command, history,
    reinject() { vm.runInContext(mainCode, mainContext); vm.runInContext(contentCode, contentContext); },
    messageAs: (message, identity) => new Promise(resolve => workerListener(message, identity, resolve)),
    authenticate: () => win.fetch('https://chatgpt.com/backend-api/me', { headers: { Authorization: 'Bearer ONLY_IN_MAIN_PRIVATE', 'oai-device-id': 'PRIVATE_DEVICE' } }),
    cleanup() { alive = false; for (const timer of timers) clearTimeout(timer); for (const timer of intervals) clearInterval(timer); },
  };
}

test('MAIN → content → worker → popup bridge works and persists only safe progress', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const view = await f.popup({ type: 'OPEN_VIEW' }); assert.equal(view.tabId, 1);
  assert.equal((await f.command('GET_STATUS')).state.auth.detected, false);
  await f.authenticate();
  assert.equal((await f.command('GET_STATUS')).state.auth.detected, true);
  await f.command('SCAN_FILES');
  await until(() => f.posted.some(p => p.state?.scan.status === 'completed'));
  assert.equal((await f.command('GET_STATUS')).state.files.length, 1);
  await f.command('START_DOWNLOADS');
  await until(() => f.downloads.length === 1);
  await until(() => f.store['cad:history:A']?.files?.[0]?.status === 'downloaded');
  assert.equal(await f.downloads[0].blob.text(), 'attachment bytes');
  assert.equal(f.downloads[0].filename, 'note.txt');
  for (const value of [f.store, f.posted, f.logs, (await f.command('GET_STATUS'))]) {
    const serialized = JSON.stringify(value);
    for (const secret of ['ONLY_IN_MAIN_PRIVATE', 'PRIVATE_DEVICE', 'Bearer']) assert.ok(!serialized.includes(secret));
  }
});
test('reinjecting scripts leaves exactly one fetch wrapper and one download command listener', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const wrapper = f.win.fetch; f.reinject(); assert.equal(f.win.fetch, wrapper);
  await f.authenticate(); await f.command('SCAN_FILES');
  await until(() => f.posted.some(p => p.state?.scan.status === 'completed'));
  await f.command('START_DOWNLOADS'); await until(() => f.downloads.length > 0); await delay(20);
  assert.equal(f.downloads.length, 1);
});
test('popup closure has no ownership of a batch; a new status request restores current progress', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  await f.authenticate(); await f.command('SCAN_FILES');
  await until(() => f.posted.some(p => p.state?.scan.status === 'completed'));
  await f.command('START_DOWNLOADS');
  // No popup messages or keepalive ports while the page completes its job.
  await delay(30);
  const reopened = await f.command('GET_STATUS');
  assert.equal(reopened.state.batch.status, 'completed'); assert.equal(reopened.state.files[0].status, 'downloaded');
});
test('history push/replace clears the list and worker rejects untrusted senders', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  await f.authenticate(); await f.command('SCAN_FILES');
  await until(() => f.posted.some(p => p.state?.scan.status === 'completed'));
  f.history.pushState({}, '', '/c/B');
  const status = await f.command('GET_STATUS');
  assert.equal(status.state.conversationId, 'B'); assert.equal(status.state.files.length, 0);
  f.history.replaceState({}, '', '/c/C'); assert.equal((await f.command('GET_STATUS')).state.conversationId, 'C');
  const rejected = await f.messageAs({ type: 'UI_COMMAND', tabId: 1, command: { type: 'SCAN_FILES', conversationId: 'C' } },
    { id: 'other-extension', url: 'https://evil.example' });
  assert.equal(rejected.ok, false);
});
