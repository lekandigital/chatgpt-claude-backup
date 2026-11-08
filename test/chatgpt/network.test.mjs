import test from 'node:test';
import assert from 'node:assert/strict';
import { core, plain, authenticated, until } from './helpers.mjs';

test('auth supports plain objects, Headers, arrays, Request, and correct override semantics', () => {
  const { Authentication } = core();
  const auth = Authentication.create();
  for (const headers of [{ Authorization: 'Bearer one' }, new Headers({ Authorization: 'Bearer two' }), [['Authorization', 'Bearer three']]]) {
    auth.observe('https://chatgpt.com/backend-api/me', { headers }); assert.equal(auth.status().detected, true);
  }
  auth.observe(new Request('https://chatgpt.com/backend-api/me', { headers: { Authorization: 'Bearer four' } }));
  assert.equal(auth.get().headers.get('authorization'), 'Bearer four');
  auth.observe(new Request('https://chatgpt.com/backend-api/me', { headers: { Authorization: 'Bearer never' } }), { headers: {} });
  assert.equal(auth.get().headers.get('authorization'), 'Bearer four');
  auth.observe('https://evil.example/backend-api/me', { headers: { Authorization: 'Bearer never' } });
  auth.observe('https://chatgpt.com/c/A', { headers: { Authorization: 'Bearer never' } });
  assert.equal(auth.get().headers.get('authorization'), 'Bearer four');
});
test('fetch wrapper preserves this, exact arguments, promise identity and synchronous errors', () => {
  const { Authentication } = core();
  const auth = Authentication.create();
  const promise = Promise.resolve('page response');
  let observed;
  const target = { fetch: function (...args) { observed = { thisValue: this, args }; return promise; } };
  const delegate = Authentication.wrap(target, auth);
  const req = new Request('https://chatgpt.com/backend-api/me');
  const options = { headers: [['Authorization', 'Bearer safe']] };
  const thisArg = {};
  assert.equal(target.fetch.call(thisArg, req, options), promise);
  assert.equal(observed.thisValue, thisArg); assert.equal(observed.args[0], req); assert.equal(observed.args[1], options);
  assert.equal(delegate(req, options), promise);
  const failure = new Error('page failure');
  const bad = { fetch() { throw failure; } }; Authentication.wrap(bad, auth);
  assert.throws(() => bad.fetch('/backend-api/me'), error => error === failure);
});
test('token refresh updates future requests; late 401 cannot erase new credentials', () => {
  const modules = core(); const auth = authenticated(modules);
  const old = auth.get().version;
  auth.observe('/backend-api/me', { headers: { Authorization: 'Bearer new' } });
  auth.invalidate(old); assert.equal(auth.status().detected, true);
  assert.equal(auth.get().headers.get('authorization'), 'Bearer new');
  auth.invalidate(auth.get().version); assert.equal(auth.status().detected, false);
  assert.throws(() => auth.get(), { code: 'AUTH_EXPIRED' });
});
test('external storage receives no account headers, credentials or referrer; ChatGPT redirects are detected manually', async () => {
  const modules = core(); const auth = authenticated(modules); const calls = [];
  auth.observe('/backend-api/me', { headers: { Authorization: 'Bearer private', 'oai-device-id': 'private', 'oai-account-id': 'private',
    'content-type': 'application/json', 'x-oai-turn-trace-id': 'trace', traceparent: 'trace', cookie: 'never-replay' } });
  const client = modules.Transfer.create({ auth, guard() {}, fetcher: async (url, init) => { calls.push(init); return new Response('bytes'); } });
  await client.request('https://chatgpt.com/backend-api/estuary/content', new AbortController().signal, r => r.text());
  await client.request('https://files.oaiusercontent.com/file?sig=SIGNED_PRIVATE', new AbortController().signal, r => r.text());
  assert.equal(calls[0].headers.get('authorization'), 'Bearer private');
  for (const name of ['content-type', 'x-oai-turn-trace-id', 'traceparent', 'cookie']) assert.equal(calls[0].headers.has(name), false);
  assert.deepEqual([...calls[1].headers], []); assert.equal(calls[1].credentials, 'omit');
  assert.equal(calls[1].referrerPolicy, 'no-referrer'); assert.equal(calls[0].redirect, 'manual'); assert.equal(calls[1].redirect, 'follow');
});
test('a ChatGPT HTTP redirect is followed with the bearer header only and its destination is checked', async () => {
  const modules = core(); const auth = authenticated(modules); const calls = [];
  const opaque = { type: 'opaqueredirect', status: 0, ok: false, redirected: false, headers: new Headers(), body: null };
  const landed = url => Object.defineProperties(new Response('%PDF-1.7 bytes'), { redirected: { value: true }, url: { value: url } });
  let destination = 'https://files.oaiusercontent.com/file?sig=SIGNED';
  const client = modules.Transfer.create({ auth, guard() {}, fetcher: async (url, init) => {
    calls.push(init); return calls.length % 2 ? opaque : landed(destination);
  } });
  assert.equal(await client.request('https://chatgpt.com/backend-api/files/download/file_a', new AbortController().signal, r => r.text()), '%PDF-1.7 bytes');
  assert.deepEqual([...calls[1].headers], [['authorization', 'Bearer TEST_ONLY_NOT_REAL']]);
  assert.equal(calls[1].redirect, 'follow'); assert.equal(calls[1].credentials, 'same-origin');
  destination = 'https://evil.example/collect';
  await assert.rejects(client.request('https://chatgpt.com/backend-api/files/download/file_a', new AbortController().signal, r => r.text()), { code: 'UNSAFE_URL' });
});
test('only a direct ChatGPT 401 expires authentication', async () => {
  const modules = core(); const auth = authenticated(modules);
  const opaque = { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), body: null };
  let calls = 0;
  const followed = modules.Transfer.create({ auth, guard() {}, fetcher: async () => ++calls === 1 ? opaque : new Response('', { status: 401 }) });
  await assert.rejects(followed.request('https://chatgpt.com/backend-api/x', new AbortController().signal, r => r.text()), { code: 'HTTP_OTHER' });
  const storage = modules.Transfer.create({ auth, guard() {}, fetcher: async () => new Response('', { status: 401 }) });
  await assert.rejects(storage.request('https://files.oaiusercontent.com/x', new AbortController().signal, r => r.text()), { code: 'HTTP_OTHER' });
  assert.equal(auth.status().detected, true);
});
test('repeated authenticated page requests announce readiness once', () => {
  const { Authentication } = core(); let changes = 0;
  const auth = Authentication.create(() => changes++);
  for (let i = 0; i < 25; i++) auth.observe('https://chatgpt.com/backend-api/conversation', { headers: { Authorization: `Bearer ${i}` } });
  assert.equal(changes, 1); assert.equal(auth.get().headers.get('authorization'), 'Bearer 24');
});
test('unsafe URLs reject localhost, wrong origins, embedded credentials and unsupported schemes', () => {
  const { Endpoints } = core();
  for (const url of ['http://chatgpt.com/backend-api/x', 'https://chatgpt.com/c/A', 'https://user:pass@chatgpt.com/backend-api/x',
    'https://chatgpt.com.evil.example/backend-api/x', 'https://127.0.0.1/x', 'https://files.oaiusercontent.com.evil.example/x', 'data:text/plain,evil']) {
    assert.throws(() => Endpoints.safeDownload(url), { code: 'UNSAFE_URL' });
  }
});
test('429 honors Retry-After and bounded fallback delays', async () => {
  const modules = core(); const waits = []; let calls = 0;
  const client = modules.Transfer.create({ auth: authenticated(modules), guard() {},
    wait: async ms => waits.push(ms), fetcher: async () => { calls++; return new Response('', { status: 429 }); } });
  await assert.rejects(client.request('https://chatgpt.com/backend-api/x', new AbortController().signal, r => r.text()), { code: 'HTTP_429' });
  assert.equal(calls, 5); assert.equal(waits.reduce((a, b) => a + b, 0), 300000);
  assert.equal(modules.Transfer.retryAfter('17', 1), 17000);
  assert.equal(modules.Transfer.retryAfter(new Date(20000).toUTCString(), 1, 10000), 10000);
  assert.equal(modules.Transfer.retryAfter(null, 3), 90000);
});
test('stop during backoff prevents any subsequent retry', async () => {
  const modules = core(); const controller = new AbortController(); let calls = 0, waiting = false;
  const client = modules.Transfer.create({ auth: authenticated(modules), guard() {}, onWait: kind => { if (kind) waiting = true; },
    fetcher: async () => { calls++; return new Response('', { status: 429 }); } });
  const task = client.request('https://chatgpt.com/backend-api/x', controller.signal, r => r.text());
  await until(() => waiting); controller.abort();
  await assert.rejects(task, { code: 'STOPPED' }); assert.equal(calls, 1);
});
test('401/403/404 are distinct and not automatically retried', async () => {
  for (const [status, code] of [[401, 'AUTH_EXPIRED'], [403, 'HTTP_403'], [404, 'HTTP_404']]) {
    const modules = core(); const auth = authenticated(modules); let calls = 0;
    const client = modules.Transfer.create({ auth, guard() {}, fetcher: async () => { calls++; return new Response('', { status }); } });
    await assert.rejects(client.request('https://chatgpt.com/backend-api/x', new AbortController().signal, r => r.text()), { code });
    assert.equal(calls, 1); if (status === 401) assert.equal(auth.status().detected, false);
  }
});
test('5xx and network retries are bounded', async () => {
  for (const [server, code, expected] of [[true, 'HTTP_5XX', 4], [false, 'NETWORK', 3]]) {
    const modules = core(); let calls = 0;
    const client = modules.Transfer.create({ auth: authenticated(modules), guard() {}, wait: async () => {},
      fetcher: async () => { calls++; if (server) return new Response('', { status: 503 }); throw new Error('private URL and headers'); } });
    await assert.rejects(client.request('https://chatgpt.com/backend-api/x', new AbortController().signal, r => r.text()), { code });
    assert.equal(calls, expected);
  }
});
test('stop aborts a fetch; a stalled body times out but steady progress does not', async () => {
  const modules = core(); const abort = new AbortController(); let received;
  const client = modules.Transfer.create({ auth: authenticated(modules), guard() {}, fetcher: (url, init) => {
    received = init.signal;
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  } });
  const task = client.request('https://chatgpt.com/backend-api/x', abort.signal, r => r.text());
  abort.abort(); await assert.rejects(task, { code: 'STOPPED' }); assert.equal(received.aborted, true);
  let calls = 0;
  const timed = modules.Transfer.create({ auth: authenticated(modules), guard() {}, stallMs: 5, wait: async () => {},
    fetcher: async () => { calls++; return new Response('x'); } });
  await assert.rejects(timed.request('https://chatgpt.com/backend-api/x', new AbortController().signal,
    (response, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))), { code: 'TIMEOUT' });
  assert.equal(calls, 3);
  // 60 ms of transfer under a 20 ms stall limit succeeds while bytes keep arriving.
  const steady = modules.Transfer.create({ auth: authenticated(modules), guard() {}, stallMs: 20, fetcher: async () => new Response('x') });
  const result = await steady.request('https://chatgpt.com/backend-api/x', new AbortController().signal, async (response, signal, touch) => {
    for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 10)); touch(); }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    return 'complete';
  });
  assert.equal(result, 'complete');
});
test('projection and diagnostics cannot serialize header maps, signed URLs, JWTs or raw errors', () => {
  const { Safety, Protocol } = core();
  const clean = Safety.state({ conversationId: 'A', title: 'Chat eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.PRIVATEsignature', authorization: 'PRIVATE',
    auth: { detected: true, headers: { Authorization: 'Bearer PRIVATE' } },
    files: [{ id: 'file_a', filename: 'secret-document.pdf', signedURL: 'https://files.oaiusercontent.com/?sig=PRIVATE',
      status: 'failed', error: { code: 'NETWORK', message: 'PRIVATE', headers: 'PRIVATE' } }],
    logs: [{ code: 'ERROR', at: 1, message: 'PRIVATE' }] });
  const serialized = JSON.stringify(clean) + JSON.stringify(Safety.diagnostics(clean)) + JSON.stringify(Safety.history(clean));
  assert.ok(!serialized.includes('PRIVATE')); assert.ok(!serialized.includes('https://')); assert.ok(!serialized.includes('headers'));
  assert.equal(Safety.text('abcdefghijkl.abcdefghijkl.abcdefgh'), '[redacted]');
  assert.equal(Safety.text('me@example.com'), '[email removed]');
  // Titles are the user's own display data: only token-shaped strings are removed.
  assert.equal(Safety.state({ conversationId: 'A', title: 'Session planning' }).title, 'Session planning');
  assert.deepEqual(Safety.shape(['files:array(2)', 'name:me@example.com', 'files[0].id:string', 'x:https://e.x/?sig=1']), ['files:array(2)', 'files[0].id:string']);
  assert.equal(Protocol.command({ type: 'FETCH_ANY_URL', url: 'https://evil.example' }), null);
  assert.deepEqual(plain(Protocol.command({ type: 'SCAN_FILES', conversationId: 'A', headers: 'PRIVATE' })), { type: 'SCAN_FILES', conversationId: 'A' });
});
