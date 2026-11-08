// Installed into a chatgpt.com tab's MAIN world by the ChatGPT backup page (chrome.scripting).
// Authentication comes from /api/auth/session — the same bearer token ChatGPT's own requests
// carry — and stays in this page together with signed URLs. The archive page only receives
// parsed JSON and file bytes, in chunks, through the frozen API below.
const ARCHIVE_API = Symbol.for('chatgpt-attachment-downloader-archive-v1');
if (location.origin === Config.ORIGIN && window === window.top && !window[ARCHIVE_API]) {
  const fetcher = (...args) => window.fetch(...args);
  let session = null;
  let version = 0;
  async function refresh() {
    const response = await fetcher('/api/auth/session', { credentials: 'include', cache: 'no-store' });
    const data = response.ok ? await response.json().catch(() => null) : null;
    if (!data?.accessToken) throw new Transfer.Fault('AUTH_WAITING');
    const headers = new Headers({ authorization: `Bearer ${data.accessToken}`, 'oai-language': navigator.language || 'en-US' });
    const device = document.cookie.match(/(?:^|;\s*)oai-did=([^;]+)/)?.[1];
    if (device) headers.set('oai-device-id', decodeURIComponent(device));
    session = { headers, version: ++version, at: Date.now() };
  }
  const auth = {
    get() {
      if (!session) throw new Transfer.Fault('AUTH_WAITING');
      return { headers: new Headers(session.headers), version: session.version };
    },
    invalidate(requestVersion) { if (session?.version === requestVersion) session = null; },
  };
  const client = Transfer.create({ fetcher, auth, guard: () => {} });
  // A fresh token every 10 minutes, and once more after an AUTH_EXPIRED.
  async function authed(task) {
    for (let attempt = 0; ; attempt++) {
      if (!session || Date.now() - session.at > 10 * 60 * 1000) await refresh();
      try { return await task(new AbortController().signal); } catch (error) {
        if (error?.code === 'AUTH_EXPIRED' && attempt === 0) { session = null; continue; }
        throw error;
      }
    }
  }
  function outcome(promise) {
    return promise.then(value => ({ ok: true, value }),
      error => ({ ok: false, code: error?.code || 'UNEXPECTED', message: String(error?.message || error).slice(0, 300),
        ...(error?.code === 'SIZE_MISMATCH' ? { expected: error.expected, actual: error.actual } : {}) }));
  }
  function json(path) {
    return outcome(authed(signal => client.request(new URL(path, Config.ORIGIN).href, signal, async response => {
      if (/html/i.test(response.headers.get('content-type') || '')) throw new Transfer.Fault('HTML_RESPONSE');
      try { return await response.json(); } catch { throw new Transfer.Fault('API_CHANGED'); }
    })));
  }
  function scanFiles(conversationId) {
    return outcome(authed(signal => AttachmentFiles.scan(client, conversationId, signal)));
  }
  const blobs = new Map();
  let nextHandle = 0;
  // spec: { conversationId, id?, url?, filename, expectedSize? } — url overrides the default
  // /backend-api/files/download/{id} start (interpreter downloads, project files…).
  function file(spec) {
    return outcome(authed(async signal => {
      const result = await AttachmentFiles.resolve(client, spec.conversationId,
        { id: spec.id, url: spec.url, filename: Safety.filename(spec.filename), expectedSize: Safety.size(spec.expectedSize) }, signal);
      if (result.link) return { link: result.link, filename: result.filename, expectedSize: result.expectedSize };
      const handle = ++nextHandle;
      blobs.set(handle, result.blob);
      return { handle, size: result.blob.size, filename: result.filename, mime: result.mime,
        verified: result.verified, expectedSize: result.expectedSize };
    }));
  }
  async function chunk(handle, offset, length) {
    const blob = blobs.get(handle);
    if (!blob) return { ok: false, code: 'NO_HANDLE' };
    const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { ok: true, value: btoa(binary) };
  }
  function release(handle) { blobs.delete(handle); return { ok: true }; }
  // Diagnostics for probe mode: status, headers and the first bytes of one GET.
  function inspectUrl(value) {
    return outcome(authed(async () => {
      const url = Endpoints.safeDownload(value);
      const internal = url.origin === Config.ORIGIN;
      const response = await fetcher(url.href, { headers: internal ? auth.get().headers : new Headers(),
        credentials: internal ? 'include' : 'omit', redirect: 'manual', cache: 'no-store' });
      const snippet = response.type === 'opaqueredirect' ? '' : (await response.text()).slice(0, 400);
      return { status: response.status, type: response.type, contentType: response.headers.get('content-type'),
        length: response.headers.get('content-length'), disposition: response.headers.get('content-disposition'), snippet };
    }));
  }
  Object.defineProperty(window, ARCHIVE_API, { value: Object.freeze({ json, scanFiles, file, chunk, release, inspectUrl }) });
}
