const CONTENT_MARKER = '__cad_isolated_v1';
if (!globalThis[CONTENT_MARKER]) {
  globalThis[CONTENT_MARKER] = true;
  const pending = new Map();
  let latest = null;
  let restoreConversation = null;
  let restoreTask = Promise.resolve();
  let persistTimer = null;
  let latestUnsaved = null;
  let storageError = false;
  function request(command) {
    return new Promise(resolve => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId); resolve({ ok: false, error: { code: 'BRIDGE' } });
      }, 3500);
      pending.set(requestId, { resolve, timer });
      window.postMessage({ namespace: Config.NAMESPACE, direction: 'TO_PAGE', requestId, command }, Config.ORIGIN);
    });
  }
  async function persist(state) {
    if (!state?.scan.lastScannedAt || !state.conversationId) return;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'SAVE_HISTORY', state: Safety.state(state) });
      storageError = reply?.ok !== true;
    } catch { storageError = true; }
  }
  function queuePersist(state) {
    latestUnsaved = state;
    // Write completion/stop transitions promptly. During a batch, save at most every 2 s.
    const busy = state.batch.status === 'running' || state.scan.status === 'scanning';
    if (!busy) { clearTimeout(persistTimer); persistTimer = null; void persist(state); return; }
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; void persist(latestUnsaved); }, 2000);
  }
  function restore(state) {
    if (state.conversationId === restoreConversation) return;
    restoreConversation = state.conversationId;
    const conversationId = restoreConversation;
    if (!conversationId) { restoreTask = Promise.resolve(); return; }
    restoreTask = (async () => {
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'LOAD_HISTORY', conversationId });
        if (reply?.history && Safety.conversation(location.href) === conversationId) {
          await request({ type: 'RESTORE_HISTORY', conversationId, files: Safety.files(reply.history.files) });
        }
      } catch { storageError = true; }
    })();
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== Config.ORIGIN || !Protocol.envelope(event.data, 'TO_EXTENSION')) return;
    if (!['STATE', 'REPLY'].includes(event.data.type)) return;
    const state = event.data.state ? Safety.state(event.data.state) : null;
    if (state && state.conversationId === Safety.conversation(location.href)) {
      latest = state;
      restore(state);
      if (event.data.type === 'STATE') queuePersist(state);
    }
    if (event.data.type === 'REPLY') {
      const match = pending.get(event.data.requestId);
      if (!match) return;
      clearTimeout(match.timer); pending.delete(event.data.requestId);
      match.resolve({ ok: event.data.ok === true, ...(state ? { state } : {}),
        ...(event.data.error ? { error: Safety.error(event.data.error) } : {}) });
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'PAGE_COMMAND') return;
    const command = Protocol.command(message.command);
    if (!command) { reply({ ok: false, error: { code: 'INVALID_FILE' } }); return; }
    void (async () => {
      if (command.type === 'SCAN_FILES') {
        // Ensure history arrives before a fast scan can finish and overwrite saved successes.
        if (restoreConversation !== command.conversationId) await request({ type: 'GET_STATUS' });
        await restoreTask;
      }
      const result = await request(command);
      reply({ ...result, storageError });
    })().catch(() => reply({ ok: false, error: { code: 'BRIDGE' } }));
    return true;
  });
  // Handshake is retried a bounded number of times; script ordering across worlds is not assumed.
  void (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await request({ type: 'GET_STATUS' });
      if (result.ok) return;
    }
  })();
  window.addEventListener('pagehide', () => {
    clearTimeout(persistTimer);
    if (latest) void persist(latest);
  });
}
