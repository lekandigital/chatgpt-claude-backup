const AttachmentFiles = (() => {
  function extract(data) {
    const found = new Map();
    const seen = new Set();
    const stack = [data];
    let visited = 0;
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      if (++visited > 100000) throw new Transfer.Fault('API_CHANGED');
      seen.add(value);
      const fileId = Safety.id(value.file_id, true) || Safety.id(value.id, true);
      if (fileId) {
        const rawName = [value.filename, value.file_name, value.name].find(n => typeof n === 'string' && n.trim() && !/^(undefined|null|\[object Object\])(?:\.|$)/i.test(n));
        const record = Safety.file({ id: fileId, filename: rawName,
          expectedSize: [value.file_size_bytes, value.size_bytes, value.size].find(s => Safety.size(s) !== null),
          mime: value.mime_type || value.mimetype || value.mime }, found.size);
        if (!found.has(fileId)) found.set(fileId, record);
        else {
          const previous = found.get(fileId);
          if (rawName && previous.filename.startsWith('chatgpt-file-')) previous.filename = record.filename;
          previous.expectedSize ??= record.expectedSize;
          previous.mime ??= record.mime;
        }
      }
      const values = Object.values(value);
      for (let i = values.length - 1; i >= 0; i--) if (values[i] && typeof values[i] === 'object') stack.push(values[i]);
    }
    return [...found.values()];
  }
  function isListShape(data) {
    if (Array.isArray(data)) return true;
    if (!data || typeof data !== 'object') return false;
    // Recognize empty collection envelopes, but reject error objects masquerading as empty scans.
    return ['files', 'items', 'data', 'attachments', 'results'].some(key =>
      Array.isArray(data[key]) || (data[key] && typeof data[key] === 'object' && isListShape(data[key])));
  }
  function describe(data) {
    // Key names and value types only — never values — so a schema change can be diagnosed safely.
    const kind = value => Array.isArray(value) ? `array(${value.length})` : value === null ? 'null' : typeof value;
    const shape = [`(root):${kind(data)}`];
    if (!data || typeof data !== 'object') return shape;
    const entries = Array.isArray(data) ? [['[0]', data[0]]] : Object.entries(data);
    for (const [key, value] of entries.slice(0, 20)) {
      shape.push(`${key}:${kind(value)}`);
      const first = Array.isArray(value) ? value[0] : null;
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        for (const nested of Object.keys(first).slice(0, 20)) shape.push(`${key}[0].${nested}:${kind(first[nested])}`);
      }
    }
    return shape;
  }
  function extension(name) { return (name.match(/\.([A-Za-z0-9]{1,12})$/)?.[1] || '').toLowerCase(); }
  async function scan(client, conversationId, signal, onShape = () => {}) {
    const all = new Map();
    const visitedPages = new Set();
    let page = null;
    let partial = false;
    for (let index = 0; index < Config.MAX_PAGES; index++) {
      Transfer.aborted(signal);
      const url = Endpoints.list(conversationId, page);
      if (visitedPages.has(url)) { partial = true; break; }
      visitedPages.add(url);
      const data = await client.request(url, signal, async response => {
        if (/html/i.test(response.headers.get('content-type') || '')) throw new Transfer.Fault('HTML_RESPONSE');
        try { return await response.json(); } catch (error) {
          if (signal.aborted || error.name === 'AbortError') throw error;
          throw new Transfer.Fault('API_CHANGED');
        }
      });
      if (index === 0) onShape(describe(data));
      const records = extract(data);
      if (!records.length && !isListShape(data)) throw new Transfer.Fault('API_CHANGED');
      let added = 0;
      for (const record of records) if (!all.has(record.id)) { all.set(record.id, record); added++; }
      const next = Endpoints.nextPage(data, records.length);
      partial = next.partial;
      if (all.size > Config.MAX_FILES || (index > 0 && !added && next.page)) { partial = true; break; }
      if (!next.page) break;
      if (index === Config.MAX_PAGES - 1) { partial = true; break; }
      page = next.page;
    }
    return { files: [...all.values()].slice(0, Config.MAX_FILES), partial };
  }
  function html(prefix, mime) {
    return /(?:text\/html|application\/xhtml\+xml)/i.test(mime) ||
      /^\s*(?:\uFEFF)?\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(prefix.replace(/^(?:\s*<!--[\s\S]*?-->)+/, ''));
  }
  async function readBody(response, mime, touch, onBytes) {
    if (!response.body) return response.blob();
    const reader = response.body.getReader();
    const parts = [];
    let chunks = [], chunkBytes = 0, total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch?.();
      total += value.byteLength; chunkBytes += value.byteLength; chunks.push(value);
      onBytes?.(total);
      // Fold chunks into Blob parts so large files sit in browser blob storage, not JS arrays.
      if (chunkBytes >= 8 * 1024 * 1024) { parts.push(new Blob(chunks)); chunks = []; chunkBytes = 0; }
    }
    if (chunks.length) parts.push(new Blob(chunks));
    return new Blob(parts, { type: mime });
  }
  const JSON_FILES = new Set(['json', 'jsonl', 'ndjson', 'geojson', 'har', 'ipynb']);
  // Text types whose contents may legitimately be HTML, e.g. a web page pasted into ChatGPT (Pasted text.txt).
  const TEXT_FILES = new Set(['txt', 'text', 'md', 'markdown', 'log', 'csv', 'tsv', 'xml', 'svg', 'eml']);
  // ChatGPT's file store (estuary content, signed storage hosts) only ever returns stored bytes,
  // never the app shell, so an .html file from it is genuine even without an announced size.
  function fileStore(value) {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== 'https:') return false;
    if (url.origin === Config.ORIGIN) return url.pathname.startsWith('/backend-api/estuary/');
    return url.hostname.endsWith('.oaiusercontent.com') || /^(?:oai)?sdmntpr[a-z0-9-]*\.(?:blob\.core\.windows\.net|s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com)$/.test(url.hostname);
  }
  const SHELL = /challenge-platform|cf-chl-|<title>\s*Just a moment|<title>\s*ChatGPT\s*<\/title>/i;
  async function inspect(response, { filename = '', expectedSize = null, touch, onBytes } = {}) {
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = extension(filename);
    // A genuine .html attachment (or text holding HTML) is accepted only when its bytes match the
    // size ChatGPT announced. An app-shell page returned in place of a file can never satisfy that.
    const stored = fileStore(response.url);
    const htmlAttachment = (ext === 'html' || ext === 'htm' || TEXT_FILES.has(ext)) && (expectedSize !== null || stored);
    if (html('', mime) && !htmlAttachment) {
      await response.body?.cancel().catch(() => {});
      throw new Transfer.Fault('HTML_RESPONSE');
    }
    const blob = await readBody(response, mime, touch, onBytes);
    const sizeMatches = expectedSize !== null && blob.size === expectedSize;
    if (!blob.size && !sizeMatches) throw new Transfer.Fault('EMPTY_RESPONSE');
    const prefix = await blob.slice(0, 1024).text();
    const unsizedStored = stored && expectedSize === null && !SHELL.test(prefix);
    if (html(prefix, mime) && !(htmlAttachment && (sizeMatches || unsizedStored))) throw new Transfer.Fault('HTML_RESPONSE');
    // A pointer can match the announced size when that size was the pointer's own (seen for
    // re-uploaded files). Outside JSON-type attachments, a success envelope is always another hop.
    if (sizeMatches && !JSON_FILES.has(ext) && blob.size <= 65536 && /^\s*\{/.test(prefix)) {
      let parsed = null;
      try { parsed = JSON.parse(await blob.text()); } catch { /* The attachment itself. */ }
      if (parsed?.status === 'success' && typeof parsed.download_url === 'string') {
        const url = Endpoints.safeDownload(parsed.download_url);
        return { metadata: { url: url.href, filename: parsed.file_name, expectedSize: Safety.size(parsed.file_size_bytes) } };
      }
    }
    // Bytes matching the announced size are the attachment itself, even when they are JSON.
    if (sizeMatches) return { blob, mime };
    if (blob.size <= Config.MAX_METADATA_BYTES && (mime.includes('json') || /^\s*\{/.test(prefix))) {
      let parsed;
      try { parsed = JSON.parse(await blob.text()); } catch { /* A JSONL or ordinary text attachment. */ }
      const object = parsed && !Array.isArray(parsed) && typeof parsed === 'object';
      if (object && Object.hasOwn(parsed, 'download_url')) {
        // Malformed metadata is an error, never a tiny JSON file saved as a PDF.
        const url = Endpoints.safeDownload(parsed.download_url);
        return { metadata: { url: url.href, filename: parsed.file_name,
          expectedSize: Safety.size(parsed.file_size_bytes) } };
      }
      // A JSON error envelope served in place of a .txt, .csv, .pdf… is not that file.
      if (object && mime.includes('json') && !JSON_FILES.has(ext) && blob.size <= 65536 &&
        (parsed.status === 'error' || Object.hasOwn(parsed, 'error') || Object.hasOwn(parsed, 'detail'))) {
        throw new Transfer.Fault('SERVER_ERROR');
      }
      // For a .json attachment only ChatGPT's own envelope counts, e.g. {"status":"error",
      // "error_code":"file_not_found","error_type":"GetDownloadLinkError","error_message":null}
      // (was once saved in place of .json uploads). Matching sizes returned above already.
      if (object && JSON_FILES.has(ext) && parsed.status === 'error' && (parsed.error_code || parsed.error_type) &&
        Object.keys(parsed).every(key => ['status', 'error_code', 'error_type', 'error_message'].includes(key))) {
        throw new Transfer.Fault('SERVER_ERROR');
      }
    }
    return { blob, mime };
  }
  async function checkMagic(blob, filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const bytes = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
    const begins = signature => signature.every((b, i) => bytes[i] === b);
    let valid = true;
    if (ext === 'pdf') valid = new TextDecoder().decode(bytes).includes('%PDF-');
    if (ext === 'png') valid = begins([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (['jpg', 'jpeg'].includes(ext)) valid = begins([0xff, 0xd8, 0xff]);
    if (['docx', 'xlsx', 'pptx', 'zip'].includes(ext)) {
      // Encrypted Office documents may use OLE; generic ZIP files may be empty.
      valid = begins([0x50, 0x4b, 0x03, 0x04]) || begins([0x50, 0x4b, 0x05, 0x06]) ||
        begins([0x50, 0x4b, 0x07, 0x08]) || (ext !== 'zip' && begins([0xd0, 0xcf, 0x11, 0xe0]));
    }
    // The failures being guarded against are text (metadata JSON, an HTML page, an error message)
    // saved under a binary name. Other binary content is still what ChatGPT served, so it passes.
    if (!valid && !/[\x00-\x08\x0e-\x1f]/.test(String.fromCharCode(...bytes.subarray(0, 512)))) {
      throw new Transfer.Fault('MAGIC_MISMATCH');
    }
  }
  async function resolve(client, conversationId, file, signal, onProgress = () => {}) {
    for (let integrityAttempt = 0; integrityAttempt < 2; integrityAttempt++) {
      let url = file.url || Endpoints.download(conversationId, file.id);
      let filename = file.filename;
      // Only file_size_bytes from download metadata is used for verification; list sizes are informational.
      let expectedSize = null;
      let result;
      for (let hops = 0; ; hops++) {
        Transfer.aborted(signal);
        onProgress('resolving');
        try {
          result = await client.request(url, signal, async (response, requestSignal, touch) => {
            onProgress('downloading');
            const length = Number(response.headers.get('content-length'));
            if (length > Config.LARGE_FILE_BYTES) onProgress('large');
            return inspect(response, { filename, expectedSize, touch, onBytes: bytes => onProgress('bytes', bytes) });
          });
        } catch (error) {
          // The signed link stays inside MAIN; Chrome fetches it without page CORS rules.
          if (hops > 0 && error?.code === 'NETWORK' && Endpoints.linkDownload(url)) {
            return { link: url, filename, expectedSize: expectedSize ?? file.expectedSize, actualSize: null, mime: null, verified: false };
          }
          throw error;
        }
        if (!result.metadata) break;
        if (hops >= Config.MAX_METADATA_HOPS) throw new Transfer.Fault('TOO_MANY_HOPS');
        onProgress('metadata');
        url = result.metadata.url;
        if (typeof result.metadata.filename === 'string' && result.metadata.filename.trim()) filename = Safety.filename(result.metadata.filename, filename);
        if (result.metadata.expectedSize !== null) expectedSize = result.metadata.expectedSize;
        if (expectedSize > Config.LARGE_FILE_BYTES) onProgress('large');
      }
      Transfer.aborted(signal);
      if (expectedSize !== null && result.blob.size !== expectedSize) {
        if (!integrityAttempt) { onProgress('size_retry'); continue; }
        throw new Transfer.Fault('SIZE_MISMATCH', { expected: expectedSize, actual: result.blob.size });
      }
      if (result.blob.size) await checkMagic(result.blob, filename);
      Transfer.aborted(signal);
      return { blob: result.blob, filename, expectedSize: expectedSize ?? file.expectedSize, actualSize: result.blob.size,
        mime: result.mime, verified: expectedSize !== null };
    }
  }
  return Object.freeze({ extract, isListShape, describe, scan, readBody, inspect, resolve, html, checkMagic, fileStore });
})();
