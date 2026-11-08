// Built as one closure: credentials, signed URLs, and file bytes remain in MAIN.
const INSTALL_MARKER = Symbol.for('chatgpt-attachment-downloader-installed-v1');
if (location.origin === Config.ORIGIN && window === window.top && !window[INSTALL_MARKER]) {
  Object.defineProperty(window, INSTALL_MARKER, { value: true, configurable: false });
  let controller;
  const auth = Authentication.create(() => controller?.authChanged());
  const fetcher = Authentication.wrap(window, auth);
  const objectURLs = new Map();
  function release(url) {
    clearTimeout(objectURLs.get(url));
    URL.revokeObjectURL(url);
    objectURLs.delete(url);
  }
  function save(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.hidden = true;
    try {
      (document.body || document.documentElement).appendChild(anchor);
      anchor.click();
      objectURLs.set(url, setTimeout(() => release(url), Config.BLOB_LIFETIME_MS));
    } catch (error) { release(url); throw error; }
    finally { anchor.remove(); }
  }
  function saveLink(url, filename) {
    // Only reached for allowlisted storage links that force Content-Disposition: attachment
    // (Endpoints.linkDownload), so Chrome downloads instead of navigating the tab.
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.rel = 'noopener noreferrer'; anchor.hidden = true;
    try { (document.body || document.documentElement).appendChild(anchor); anchor.click(); }
    finally { anchor.remove(); }
  }
  function post(payload) {
    window.postMessage({ namespace: Config.NAMESPACE, direction: 'TO_EXTENSION', ...payload }, Config.ORIGIN);
  }
  controller = JobController.create({ auth, fetcher, href: () => location.href,
    title: () => document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, ''), save, saveLink,
    emit: state => post({ type: 'STATE', requestId: 'event', state }) });
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== Config.ORIGIN || !Protocol.envelope(event.data, 'TO_PAGE')) return;
    const command = Protocol.command(event.data.command, true);
    if (!command) return;
    const result = controller.command(command);
    post({ type: 'REPLY', requestId: event.data.requestId, ok: result.ok,
      ...(result.state ? { state: Safety.state(result.state) } : {}),
      ...(result.error ? { error: Safety.error(result.error) } : {}) });
  });
  // Preserve other wrappers and their return/throw behavior. Never restore a stale reference.
  for (const method of ['pushState', 'replaceState']) {
    const previous = history[method];
    history[method] = function (...args) {
      const result = Reflect.apply(previous, this, args);
      controller.navigate();
      return result;
    };
  }
  window.addEventListener('popstate', () => controller.navigate());
  // Fallback for another script replacing a history wrapper after installation.
  setInterval(() => controller.navigate(), 500);
  window.addEventListener('pagehide', () => {
    controller.stop(); auth.clear();
    for (const url of objectURLs.keys()) release(url);
  });
  window.addEventListener('pageshow', () => controller.navigate());
}
