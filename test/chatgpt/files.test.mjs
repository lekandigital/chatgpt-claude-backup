import test from 'node:test';
import assert from 'node:assert/strict';
import { core, plain, json, authenticated } from './helpers.mjs';

test('nested extraction preserves order, deduplicates IDs, and keeps size/mime', () => {
  const { AttachmentFiles } = core();
  const files = AttachmentFiles.extract({ data: [{ file_id: 'file_one', name: 'notes.txt', size: 8 },
    { nested: { id: 'file_two', file_name: 'deck.pdf', mime_type: 'application/pdf' } },
    { id: 'file_one', filename: 'duplicate.txt' }, { id: 'not_a_file' }] });
  assert.equal(files.length, 2); assert.equal(files[0].filename, 'notes.txt');
  assert.equal(files[0].expectedSize, 8); assert.equal(files[1].mime, 'application/pdf');
});
test('missing, invalid, unsafe and reserved filenames are sanitized', () => {
  const { Safety } = core();
  for (const name of [undefined, null, {}, 'undefined', 'null', '[object Object]', 'undefined.html']) {
    assert.equal(Safety.filename(name, 'fallback.pdf'), 'fallback.pdf');
  }
  assert.equal(Safety.filename('../CON.pdf'), '_CON.pdf');
  assert.ok(!/[\/\\:]/.test(Safety.filename('../../foo:bar\\evil.pdf')));
  const long = Safety.filename('😀'.repeat(200) + '.pdf');
  assert.ok(Buffer.byteLength(long) <= 200); assert.ok(long.endsWith('.pdf'));
});
test('direct file bytes are accepted', async () => {
  const { AttachmentFiles } = core();
  const result = await AttachmentFiles.inspect(new Response('%PDF-1.7\nreal bytes', { headers: { 'content-type': 'application/pdf' } }));
  assert.equal(await result.blob.text(), '%PDF-1.7\nreal bytes');
});
test('two-stage PDF resolves actual bytes and checks metadata size', async () => {
  const modules = core();
  const bytes = '%PDF-1.7\nreal bytes';
  const calls = [];
  const client = modules.Transfer.create({ auth: authenticated(modules), guard() {}, fetcher: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? json({ download_url: '/backend-api/estuary/content?id=SIGNED_PRIVATE', file_name: 'actual.pdf', file_size_bytes: bytes.length }) : new Response(bytes);
  } });
  const file = modules.Safety.file({ id: 'file_one', filename: 'wrong.txt' });
  const result = await modules.AttachmentFiles.resolve(client, 'A', file, new AbortController().signal);
  assert.equal(calls.length, 2); assert.equal(result.filename, 'actual.pdf'); assert.equal(result.verified, true);
  assert.equal(await result.blob.text(), bytes);
});
test('HTML is rejected by MIME, prefix, case, BOM and leading comment', async () => {
  const { AttachmentFiles } = core();
  for (const [body, type] of [['ordinary', 'text/html'], ['ordinary', 'application/xhtml+xml'], ['<!DOCTYPE html><html>app</html>', 'application/octet-stream'],
    ['  <HTML class="chatgpt-theme">bad', 'application/pdf'], ['\uFEFF<html>bad', 'text/plain'], ['<!-- comment -->\n<html>bad', 'application/octet-stream']]) {
    await assert.rejects(AttachmentFiles.inspect(new Response(body, { headers: { 'content-type': type } })), { code: 'HTML_RESPONSE' });
  }
});
test('legitimate JSON and JSONL retain their exact bytes', async () => {
  const { AttachmentFiles } = core();
  for (const text of [JSON.stringify({ message: 'x'.repeat(3000) }), '{"line":1}\n{"line":2}\n', '{"download_url_note":"not metadata"}']) {
    const result = await AttachmentFiles.inspect(new Response(text, { headers: { 'content-type': 'application/json' } }));
    assert.equal(await result.blob.text(), text);
  }
});
test('zero-byte and malformed metadata never become downloads', async () => {
  const { AttachmentFiles } = core();
  await assert.rejects(AttachmentFiles.inspect(new Response('')), { code: 'EMPTY_RESPONSE' });
  for (const value of [null, 'javascript:alert(1)', 'https://evil.example/path']) {
    await assert.rejects(AttachmentFiles.inspect(json({ download_url: value })), { code: 'UNSAFE_URL' });
  }
});
test('magic checks catch JSON mislabeled as PDF; arbitrary file types pass', async () => {
  const { AttachmentFiles } = core();
  await assert.rejects(AttachmentFiles.checkMagic(new Blob(['{"status":"success"}']), 'deck.pdf'), { code: 'MAGIC_MISMATCH' });
  await AttachmentFiles.checkMagic(new Blob(['anything']), 'notes.custom');
  await AttachmentFiles.checkMagic(new Blob([new Uint8Array([0x50, 0x4b, 0x05, 0x06])]), 'empty.zip');
});
test('size mismatch retries once and reports expected/actual without returning bytes', async () => {
  const { AttachmentFiles, Safety } = core();
  let calls = 0;
  const client = { request: async (url, signal, consume) => { calls++; return consume(calls % 2 ? json({ download_url: '/backend-api/estuary/content', file_size_bytes: 100 }) : new Response('tiny')); } };
  await assert.rejects(AttachmentFiles.resolve(client, 'A', Safety.file({ id: 'file_a', filename: 'a.txt' }), new AbortController().signal), { code: 'SIZE_MISMATCH', expected: 100, actual: 4 });
  assert.equal(calls, 4);
});
test('four metadata hops are allowed; a fifth is rejected', async () => {
  const { AttachmentFiles, Safety } = core();
  for (const allowed of [true, false]) {
    let calls = 0;
    const client = { request: async (url, signal, consume) => consume(++calls <= (allowed ? 4 : 5) ? json({ download_url: '/backend-api/estuary/content' }) : new Response('file')) };
    const task = AttachmentFiles.resolve(client, 'A', Safety.file({ id: 'file_a', filename: 'a.txt' }), new AbortController().signal);
    if (allowed) assert.equal(await (await task).blob.text(), 'file');
    else await assert.rejects(task, { code: 'TOO_MANY_HOPS' });
    assert.equal(calls, 5);
  }
});
test('recognized cursor and offset pagination are followed; uncertain lists show partial', async () => {
  const { AttachmentFiles, Endpoints } = core();
  const urls = [];
  const client = { request: async (url, signal, consume) => {
    urls.push(url);
    return consume(json(urls.length === 1 ? { files: [{ id: 'file_1', name: '1.txt' }], next_cursor: 'NEXT_PRIVATE' } : { files: [{ id: 'file_2', name: '2.txt' }], has_more: false }));
  } };
  const result = await AttachmentFiles.scan(client, 'A', new AbortController().signal);
  assert.equal(result.files.length, 2); assert.equal(result.partial, false);
  assert.ok(urls[1].includes('cursor=NEXT_PRIVATE'));
  assert.equal(Endpoints.nextPage({}, 200).partial, true);
  assert.equal(Endpoints.nextPage({ has_more: true, next: '/unknown' }, 1).partial, true);
  assert.deepEqual(plain(Endpoints.nextPage({ pagination: { next_offset: 200 } }, 200).page), { kind: 'offset', value: 200 });
});
test('repeated pagination cursors stop without an infinite loop', async () => {
  const { AttachmentFiles } = core();
  let calls = 0;
  const result = await AttachmentFiles.scan({ request: async (url, signal, consume) => {
    calls++; return consume(json({ files: [{ id: 'file_1', name: 'a.txt' }], next_cursor: 'same' }));
  } }, 'A', new AbortController().signal);
  assert.equal(calls, 2); assert.equal(result.partial, true);
});
test('empty lists work; unexpected API objects are reported', async () => {
  const { AttachmentFiles } = core();
  const response = value => ({ request: (url, signal, consume) => consume(json(value)) });
  assert.equal((await AttachmentFiles.scan(response({ files: [] }), 'A', new AbortController().signal)).files.length, 0);
  await assert.rejects(AttachmentFiles.scan(response({ error: 'changed' }), 'A', new AbortController().signal), { code: 'API_CHANGED' });
});
test('ordinary words and emails in attachment names are kept, not redacted', () => {
  const { Safety } = core();
  for (const name of ['session-notes.txt', 'Tokenizer design.md', 'cookie-policy.pdf', 'lekan@example.com resume.pdf', 'password-reset-flow.png']) {
    assert.equal(Safety.filename(name), name);
  }
  assert.equal(Safety.filename('invoice‮fdp.exe'), 'invoicefdp.exe');
});
function metadataClient(first, second, calls = []) {
  return { request: async (url, signal, consume) => { calls.push(url); return consume(calls.length === 1 ? first : second()); } };
}
test('a list size that differs from the bytes does not fail the file; only metadata size verifies', async () => {
  const { AttachmentFiles, Safety } = core();
  const file = Safety.file({ id: 'file_a', filename: 'a.txt', expectedSize: 999 });
  const result = await AttachmentFiles.resolve({ request: (url, signal, consume) => consume(new Response('abc')) }, 'A', file, new AbortController().signal);
  assert.equal(result.actualSize, 3); assert.equal(result.verified, false);
});
test('a genuine .html attachment is accepted only when metadata size matches; an app shell never is', async () => {
  const { AttachmentFiles, Safety } = core();
  const page = '<!DOCTYPE html><html><body>my exported page</body></html>';
  const html = () => new Response(page, { headers: { 'content-type': 'text/html' } });
  const ok = await AttachmentFiles.resolve(metadataClient(json({ download_url: '/backend-api/estuary/content?id=x', file_size_bytes: page.length }), html),
    'A', Safety.file({ id: 'file_a', filename: 'report.html' }), new AbortController().signal);
  assert.equal(await ok.blob.text(), page); assert.equal(ok.verified, true);
  await assert.rejects(AttachmentFiles.resolve(metadataClient(json({ download_url: '/backend-api/estuary/content?id=x', file_size_bytes: page.length + 5 }), html),
    'A', Safety.file({ id: 'file_a', filename: 'report.html' }), new AbortController().signal), { code: 'HTML_RESPONSE' });
  await assert.rejects(AttachmentFiles.resolve(metadataClient(html(), html), 'A', Safety.file({ id: 'file_a', filename: 'report.html' }), new AbortController().signal), { code: 'HTML_RESPONSE' });
  await assert.rejects(AttachmentFiles.resolve(metadataClient(json({ download_url: '/backend-api/estuary/content?id=x', file_size_bytes: page.length }), html),
    'A', Safety.file({ id: 'file_a', filename: 'deck.pdf' }), new AbortController().signal), { code: 'HTML_RESPONSE' });
});
test('a JSON attachment that itself contains download_url is kept when its size matches the metadata', async () => {
  const { AttachmentFiles, Safety } = core();
  const body = JSON.stringify({ download_url: 'https://example.org/release.zip', note: 'user data' });
  const result = await AttachmentFiles.resolve(metadataClient(json({ download_url: '/backend-api/estuary/content?id=x', file_size_bytes: body.length }),
    () => json(JSON.parse(body))), 'A', Safety.file({ id: 'file_a', filename: 'release.json' }), new AbortController().signal);
  assert.equal(await result.blob.text(), body);
});
test('a JSON error envelope is not saved as a .txt or .csv; a .json attachment with an error key is kept', async () => {
  const { AttachmentFiles } = core();
  for (const body of [{ detail: 'Not found' }, { status: 'error', message: 'expired' }, { error: { code: 'x' } }]) {
    await assert.rejects(AttachmentFiles.inspect(json(body), { filename: 'data.csv' }), { code: 'SERVER_ERROR' });
  }
  const kept = await AttachmentFiles.inspect(json({ error: 'logged by my app' }), { filename: 'app-log.json' });
  assert.equal(await kept.blob.text(), '{"error":"logged by my app"}');
});
test("ChatGPT's own error envelope is not saved as a .json upload unless its size is the file's", async () => {
  const { AttachmentFiles } = core();
  const envelope = { status: 'error', error_code: 'file_not_found', error_type: 'GetDownloadLinkError', error_message: null };
  await assert.rejects(AttachmentFiles.inspect(json(envelope), { filename: 'export.json', expectedSize: 30246 }), { code: 'SERVER_ERROR' });
  await assert.rejects(AttachmentFiles.inspect(json(envelope), { filename: 'export.json' }), { code: 'SERVER_ERROR' });
  const own = await AttachmentFiles.inspect(json({ status: 'error', error_code: 7, note: 'my test fixture' }), { filename: 'fixture.json' });
  assert.ok((await own.blob.text()).includes('my test fixture'));
  const size = JSON.stringify(envelope).length;
  const exact = await AttachmentFiles.inspect(json(envelope), { filename: 'saved-error.json', expectedSize: size });
  assert.equal((await exact.blob.text()).length, size);
});
test('a zero-byte file is accepted only when metadata says the file is empty', async () => {
  const { AttachmentFiles, Safety } = core();
  const empty = await AttachmentFiles.resolve(metadataClient(json({ download_url: '/backend-api/estuary/content?id=x', file_size_bytes: 0 }), () => new Response('')),
    'A', Safety.file({ id: 'file_a', filename: 'empty.txt' }), new AbortController().signal);
  assert.equal(empty.actualSize, 0);
  await assert.rejects(AttachmentFiles.resolve(metadataClient(json({ download_url: '/backend-api/estuary/content?id=x' }), () => new Response('')),
    'A', Safety.file({ id: 'file_a', filename: 'empty.txt' }), new AbortController().signal), { code: 'EMPTY_RESPONSE' });
});
test('magic checks fail text posing as a binary type but allow other binary content', async () => {
  const { AttachmentFiles } = core();
  await AttachmentFiles.checkMagic(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])]), 'photo.png');
  await assert.rejects(AttachmentFiles.checkMagic(new Blob(['Not Found']), 'photo.png'), { code: 'MAGIC_MISMATCH' });
});
test('a storage link refused by CORS falls back to a Chrome download only when it forces attachment', async () => {
  const { AttachmentFiles, Safety, Transfer } = core();
  const forced = 'https://files.oaiusercontent.com/f?rscd=attachment%3B%20filename%3Ddeck.pdf&sig=SIGNED';
  for (const [link, expectLink] of [[forced, true], ['https://files.oaiusercontent.com/f?sig=SIGNED', false]]) {
    let calls = 0;
    const client = { request: async (url, signal, consume) => {
      if (++calls === 1) return consume(json({ download_url: link, file_name: 'deck.pdf', file_size_bytes: 10 }));
      throw new Transfer.Fault('NETWORK');
    } };
    const task = AttachmentFiles.resolve(client, 'A', Safety.file({ id: 'file_a', filename: 'deck.pdf' }), new AbortController().signal);
    if (expectLink) { const result = await task; assert.equal(result.link, forced); assert.equal(result.verified, false); }
    else await assert.rejects(task, { code: 'NETWORK' });
  }
});
test('response bodies stream with byte progress and the list shape records keys and types only', async () => {
  const { AttachmentFiles } = core();
  const seen = [];
  const stream = new ReadableStream({ start(controller) { for (const part of ['ab', 'cd', 'ef']) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } });
  const result = await AttachmentFiles.inspect(new Response(stream), { filename: 'a.txt', onBytes: bytes => seen.push(bytes) });
  assert.equal(await result.blob.text(), 'abcdef'); assert.deepEqual(seen, [2, 4, 6]);
  const shape = AttachmentFiles.describe({ items: [{ id: 'file_PRIVATE', name: 'secret.pdf', size: 9 }], cursor: null });
  assert.deepEqual(plain(shape), ['(root):object', 'items:array(1)', 'items[0].id:string', 'items[0].name:string', 'items[0].size:number', 'cursor:null']);
});

test('a pasted web page saved as .txt is kept when its size matches; HTML posing as a PDF is not', async () => {
  const { AttachmentFiles, Safety } = core();
  const page = '<!DOCTYPE html><html><body>pasted page</body></html>';
  const html = () => new Response(page, { headers: { 'content-type': 'text/html' } });
  const ok = await AttachmentFiles.resolve(metadataClient(json({ download_url: '/backend-api/estuary/content?id=x', file_size_bytes: page.length }), html),
    'A', Safety.file({ id: 'file_a', filename: 'Pasted text.txt' }), new AbortController().signal);
  assert.equal(await ok.blob.text(), page); assert.equal(ok.verified, true);
  await assert.rejects(AttachmentFiles.resolve(metadataClient(html(), html), 'A', Safety.file({ id: 'file_a', filename: 'Pasted text.txt' }),
    new AbortController().signal), { code: 'HTML_RESPONSE' });
});
test('a pointer whose own size matches the announced size is followed to the real file', async () => {
  const { AttachmentFiles, Safety } = core();
  const pdf = '%PDF-1.7\nthe real deck';
  const pointer = JSON.stringify({ status: 'success', download_url: '/backend-api/estuary/content?id=real', file_name: 'deck.pdf', file_size_bytes: pdf.length });
  const responses = [json({ download_url: '/backend-api/estuary/content?id=ptr', file_size_bytes: pointer.length }),
    new Response(pointer, { headers: { 'content-type': 'application/json' } }), new Response(pdf, { headers: { 'content-type': 'application/pdf' } })];
  let call = 0;
  const client = { request: async (url, signal, consume) => consume(responses[call++]) };
  const result = await AttachmentFiles.resolve(client, 'A', Safety.file({ id: 'file_a', filename: 'deck.pdf' }), new AbortController().signal);
  assert.equal(await result.blob.text(), pdf); assert.equal(result.verified, true); assert.equal(call, 3);
});

test('an unsized .html file from the file store is kept; app shells and challenge pages never are', async () => {
  const { AttachmentFiles } = core();
  const from = (url, body) => { const r = new Response(body, { headers: { 'content-type': 'text/html' } }); Object.defineProperty(r, 'url', { value: url }); return r; };
  const store = 'https://chatgpt.com/backend-api/estuary/content?id=file_x&sig=y';
  const page = '<!DOCTYPE html><html><head><title>Glass button</title></head><body>generated</body></html>';
  const ok = await AttachmentFiles.inspect(from(store, page), { filename: 'index.html' });
  assert.equal(await ok.blob.text(), page);
  await assert.rejects(AttachmentFiles.inspect(from(store, '<html><head><title>ChatGPT</title></head></html>'), { filename: 'index.html' }), { code: 'HTML_RESPONSE' });
  await assert.rejects(AttachmentFiles.inspect(from(store, '<html><title>Just a moment...</title></html>'), { filename: 'index.html' }), { code: 'HTML_RESPONSE' });
  await assert.rejects(AttachmentFiles.inspect(from('https://chatgpt.com/c/abc', page), { filename: 'index.html' }), { code: 'HTML_RESPONSE' });
  await assert.rejects(AttachmentFiles.inspect(from(store, page), { filename: 'deck.pdf' }), { code: 'HTML_RESPONSE' });
  assert.equal(AttachmentFiles.fileStore('https://files.oaiusercontent.com/file-abc?se=1'), true);
  assert.equal(AttachmentFiles.fileStore('https://evil.example/backend-api/estuary/content'), false);
});
