import test from 'node:test';
import assert from 'node:assert/strict';
import { jobHarness, json, until } from './helpers.mjs';
import { setTimeout as delay } from 'node:timers/promises';

function route(files, callback) {
  return async (url, init) => url.includes('/conversations/') ? json({ files }) : callback(url, init);
}
test('downloads are sequential, spaced, and normal resume skips completed files', async () => {
  let active = 0, highest = 0, calls = 0;
  const files = Array.from({ length: 75 }, (_, i) => ({ id: `file_${i}`, name: `notes-${i}.txt` }));
  const h = jobHarness(route(files, async () => {
    active++; highest = Math.max(highest, active); calls++;
    await delay(1); active--; return new Response('content');
  }));
  await h.scan(); assert.equal(h.job.snapshot().files.length, 75);
  assert.equal(h.command('START_DOWNLOADS').ok, true); await h.finish();
  assert.equal(highest, 1); assert.equal(calls, 75); assert.equal(h.saves.length, 75);
  assert.equal(h.waits.length, 74); assert.ok(h.waits.every(ms => ms === 1500));
  h.command('RESUME'); await delay(5); assert.equal(calls, 75);
  assert.ok(h.job.snapshot().files.every(f => f.status === 'downloaded'));
});
test('download selected may explicitly redownload a completed file', async () => {
  const h = jobHarness(route([{ id: 'file_a', name: 'a.txt' }, { id: 'file_b', name: 'b.txt' }], async () => new Response('data')));
  await h.scan(); h.command('DOWNLOAD_SELECTED', { ids: ['file_a'] }); await h.finish();
  assert.equal(h.saves.length, 1); assert.equal(h.job.snapshot().files[1].status, 'pending');
  h.command('DOWNLOAD_SELECTED', { ids: ['file_a'] }); await h.finish();
  assert.equal(h.saves.length, 2); assert.notEqual(h.saves[0].filename, h.saves[1].filename);
  assert.equal(h.command('DOWNLOAD_SELECTED', { ids: ['file_unknown'] }).ok, false);
});
test('stop during fetch preserves completed files and leaves unstarted files pending', async () => {
  let holding = false, hold = true;
  const h = jobHarness(route(['a', 'b', 'c'].map(id => ({ id: `file_${id}`, name: `${id}.txt` })), async (url, init) => {
    if (url.includes('file_b') && hold) {
      holding = true;
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return new Response('data');
  }));
  await h.scan(); h.command('START_DOWNLOADS'); await until(() => holding);
  h.command('STOP_DOWNLOADS'); await delay(5);
  assert.deepEqual(Array.from(h.job.snapshot().files, f => f.status), ['downloaded', 'stopped', 'pending']);
  assert.equal(h.job.snapshot().batch.status, 'stopped'); assert.equal(h.saves.length, 1);
  hold = false; h.command('RESUME'); await h.finish();
  assert.equal(h.saves.length, 3); assert.ok(h.job.snapshot().files.every(f => f.status === 'downloaded'));
});
test('stop during the inter-file delay does not change successful file status', async () => {
  let sleeping = false;
  let h;
  h = jobHarness(route([{ id: 'file_a', name: 'a.txt' }, { id: 'file_b', name: 'b.txt' }], async () => new Response('data')), {
    wait: (ms, signal) => { sleeping = true; return h.Transfer.sleep(ms, signal); },
  });
  await h.scan(); h.command('START_DOWNLOADS'); await until(() => sleeping);
  h.command('STOP_DOWNLOADS'); await delay(5);
  assert.deepEqual(Array.from(h.job.snapshot().files, f => f.status), ['downloaded', 'pending']);
  assert.equal(h.saves.length, 1);
});
test('SPA navigation aborts the old operation and requires a new scan', async () => {
  let fetching = false;
  const h = jobHarness(route([{ id: 'file_a', name: 'a.txt' }], async (url, init) => {
    fetching = true;
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  }));
  await h.scan(); h.command('START_DOWNLOADS'); await until(() => fetching);
  h.navigate('https://chatgpt.com/c/B'); await delay(5);
  assert.equal(h.saves.length, 0); assert.equal(h.job.snapshot().conversationId, 'B');
  assert.equal(h.job.snapshot().files.length, 0); assert.equal(h.command('RESUME').error.code, 'SCAN_REQUIRED');
});
test('navigation immediately before save is guarded even without history events', async () => {
  let h;
  h = jobHarness(route([{ id: 'file_a', name: 'a.txt' }], async () => {
    h.setLocation('https://chatgpt.com/c/B'); return new Response('data');
  }));
  await h.scan(); h.command('START_DOWNLOADS'); await delay(10);
  h.job.navigate(); assert.equal(h.saves.length, 0); assert.equal(h.job.snapshot().conversationId, 'B');
});
test('authentication waiting is safe; 401 pauses without trying remaining files', async () => {
  let expired = true, calls = 0;
  const h = jobHarness(route([{ id: 'file_a', name: 'a.txt' }, { id: 'file_b', name: 'b.txt' }], async () => {
    calls++; return expired ? new Response('', { status: 401 }) : new Response('data');
  }));
  h.auth.clear(); assert.equal(h.command('SCAN_FILES').error.code, 'AUTH_WAITING');
  h.auth.observe('/backend-api/me', { headers: { Authorization: 'Bearer fresh' } });
  await h.scan(); h.command('START_DOWNLOADS'); await h.finish();
  assert.equal(calls, 1); assert.equal(h.job.snapshot().batch.status, 'paused');
  assert.deepEqual(Array.from(h.job.snapshot().files, f => f.status), ['stopped', 'pending']);
  expired = false; h.auth.observe('/backend-api/me', { headers: { Authorization: 'Bearer newer' } });
  h.command('RESUME'); await h.finish(); assert.equal(h.saves.length, 2);
});
test('file-specific errors continue the batch and Retry failed only retries failures', async () => {
  let bad = true;
  const h = jobHarness(route([{ id: 'file_a', name: 'a.txt' }, { id: 'file_b', name: 'b.txt' }], async url =>
    url.includes('file_a') && bad ? new Response('<html>bad') : new Response('data')));
  await h.scan(); h.command('START_DOWNLOADS'); await h.finish();
  assert.deepEqual(Array.from(h.job.snapshot().files, f => f.status), ['failed', 'downloaded']);
  bad = false; h.command('RETRY_FAILED'); await h.finish(); assert.equal(h.saves.length, 2);
});
test('a recreated controller restores only sanitized history after fresh scan', async () => {
  const fetcher = route([{ id: 'file_a', name: 'a.txt' }, { id: 'file_b', name: 'b.txt' }], async () => new Response('data'));
  const first = jobHarness(fetcher); await first.scan(); first.command('DOWNLOAD_SELECTED', { ids: ['file_a'] }); await first.finish();
  const saved = JSON.parse(JSON.stringify(first.Safety.history(first.job.snapshot())));
  const second = jobHarness(fetcher);
  second.command('RESTORE_HISTORY', { files: saved.files });
  assert.equal(second.job.snapshot().files.length, 0); assert.equal(second.command('START_DOWNLOADS').error.code, 'SCAN_REQUIRED');
  await second.scan(); second.command('RESUME'); await second.finish();
  assert.equal(second.saves.length, 1); assert.equal(second.saves[0].filename, 'b.txt');
});
test('duplicate long and ordinary filenames retain extensions and do not overwrite', async () => {
  for (const name of ['same.txt', 'x'.repeat(196) + '.txt']) {
    const h = jobHarness(route([{ id: 'file_a', name }, { id: 'file_b', name }], async () => new Response('data')));
    await h.scan(); h.command('START_DOWNLOADS'); await h.finish();
    assert.equal(h.saves.length, 2); assert.notEqual(h.saves[0].filename, h.saves[1].filename);
    assert.ok(h.saves.every(f => f.filename.endsWith('.txt') && Buffer.byteLength(f.filename) <= 200));
  }
});
test('all emitted events and persisted history omit actual credentials and signed links', async () => {
  let calls = 0;
  const h = jobHarness(route([{ id: 'file_a', name: 'deck.pdf' }], async () => {
    calls++; return calls === 1 ? json({ download_url: '/backend-api/estuary/content?signature=SIGNED_PRIVATE', file_name: 'deck.pdf' }) : new Response('%PDF-1.7\nfile');
  }));
  await h.scan(); h.command('START_DOWNLOADS'); await h.finish();
  const serialized = JSON.stringify(h.events) + JSON.stringify(h.Safety.history(h.job.snapshot())) + JSON.stringify(h.Safety.diagnostics(h.job.snapshot()));
  for (const privateText of ['TEST_ONLY_NOT_REAL', 'TEST_DEVICE_PRIVATE', 'SIGNED_PRIVATE', 'authorization', 'Bearer', 'download_url']) assert.ok(!serialized.includes(privateText));
});
test('a CORS-refused storage link is handed to Chrome inside MAIN and marked unverified', async () => {
  const links = [];
  const forced = 'https://files.oaiusercontent.com/f?rscd=attachment%3B%20filename%3Dd.bin&sig=SIGNED_PRIVATE';
  const h = jobHarness(route([{ id: 'file_a', name: 'd.bin' }], async url => {
    if (url.startsWith('https://files.oaiusercontent.com/')) throw new TypeError('Failed to fetch');
    return json({ download_url: forced, file_name: 'd.bin', file_size_bytes: 4 });
  }), { saveLink: (url, filename) => links.push({ url, filename }) });
  await h.scan(); h.command('START_DOWNLOADS'); await h.finish();
  assert.equal(h.saves.length, 0); assert.deepEqual(links, [{ url: forced, filename: 'd.bin' }]);
  const [file] = h.job.snapshot().files;
  assert.equal(file.status, 'downloaded'); assert.equal(file.delivery, 'link'); assert.equal(file.verified, false);
  assert.ok(!JSON.stringify(h.events).includes('SIGNED_PRIVATE'));
});
test('byte progress is published for the active file and cleared afterwards', async () => {
  // Four chunks over ~600 ms: progress publishes are throttled, so a slow body is needed to see one.
  const slow = () => new Response(new ReadableStream({ async pull(controller) {
    await delay(150); controller.enqueue(new Uint8Array(1024));
    if (++slow.sent === 4) controller.close();
  } }));
  slow.sent = 0;
  const h = jobHarness(route([{ id: 'file_a', name: 'a.bin' }], async () => slow()));
  await h.scan(); h.command('START_DOWNLOADS'); await until(() => h.job.snapshot().batch.status !== 'running', 'batch did not finish', 400);
  assert.ok(h.events.some(event => event.activeBytes > 0 && event.activeBytes < 4096));
  assert.equal(h.job.snapshot().activeBytes, null);
});
