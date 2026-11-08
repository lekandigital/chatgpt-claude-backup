// No credentials, file bytes, or download URLs are handled by this worker. It shares the
// extension's service worker with the Claude half (claude/background.js), so it only answers
// messages that carry a `type` (Claude's use `action`). Automation links are handled in the root
// background.js.
let writes = Promise.resolve();
const historyKey = id => `cad:history:${id}`;
const INDEX_KEY = 'cad:history-index';
const ACK_KEY = 'cad:multiple-downloads-ack';
const TRANSCRIPT_KEY = 'cad:include-transcript';
function pageSender(sender) {
  try { return sender.id === chrome.runtime.id && sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) && new URL(sender.url).origin === Config.ORIGIN; }
  catch { return false; }
}
function popupSender(sender) {
  return sender.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('chatgpt/popup/popup.html');
}
async function saveHistory(raw) {
  const state = Safety.state(raw);
  const history = Safety.history(state);
  if (!history || !history.lastScannedAt) return { ok: true };
  const key = historyKey(history.conversationId);
  const stored = await chrome.storage.local.get([INDEX_KEY, key]);
  // Preserve completed records from other tabs of the same conversation.
  const previous = Safety.files(stored[key]?.files);
  const completed = new Map(previous.filter(f => f.status === 'downloaded').map(f => [f.id, f]));
  const files = history.files.map(file => file.status !== 'downloaded' && completed.has(file.id) ? completed.get(file.id) : file);
  const known = new Set(files.map(f => f.id));
  for (const file of completed.values()) if (!known.has(file.id) && files.length < Config.MAX_FILES) files.push(file);
  const oldIndex = Array.isArray(stored[INDEX_KEY]) ? stored[INDEX_KEY].filter(id => Safety.id(id)) : [];
  const index = [history.conversationId, ...oldIndex.filter(id => id !== history.conversationId)];
  await chrome.storage.local.set({ [key]: { ...history, files }, [INDEX_KEY]: index.slice(0, Config.HISTORY_LIMIT) });
  if (index.length > Config.HISTORY_LIMIT) await chrome.storage.local.remove(index.slice(Config.HISTORY_LIMIT).map(historyKey));
  return { ok: true };
}
async function route(message, sender) {
  if (pageSender(sender)) {
    if (message?.type === 'SAVE_HISTORY') {
      const state = Safety.state(message.state);
      if (!state || state.conversationId !== Safety.conversation(sender.url)) return { ok: false };
      // Serialize writes across wakeups/messages to prevent old snapshots winning a race.
      const job = writes.then(() => saveHistory(state));
      writes = job.catch(() => {});
      return job;
    }
    if (message?.type === 'LOAD_HISTORY' && Safety.id(message.conversationId) && message.conversationId === Safety.conversation(sender.url)) {
      await writes;
      const key = historyKey(message.conversationId);
      const result = await chrome.storage.local.get(key);
      return { ok: true, history: result[key] ? {
        conversationId: message.conversationId, files: Safety.files(result[key].files),
      } : null };
    }
    return { ok: false };
  }
  if (!popupSender(sender)) return { ok: false };
  if (message?.type === 'OPEN_VIEW') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const prefs = await chrome.storage.local.get([ACK_KEY, TRANSCRIPT_KEY]);
    let chatgpt = false;
    try { chatgpt = new URL(tab?.url).origin === Config.ORIGIN; } catch { /* Unsupported page. */ }
    return { ok: true, tabId: chatgpt ? tab.id : null, acknowledged: prefs[ACK_KEY] === true,
      includeTranscript: prefs[TRANSCRIPT_KEY] !== false };
  }
  if (message?.type === 'SET_INCLUDE_TRANSCRIPT') {
    await chrome.storage.local.set({ [TRANSCRIPT_KEY]: message.value === true }); return { ok: true };
  }
  if (message?.type === 'ACK_DOWNLOADS') {
    await chrome.storage.local.set({ [ACK_KEY]: true }); return { ok: true };
  }
  if (message?.type === 'CLEAR_HISTORY') {
    const job = writes.then(async () => {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter(key => key.startsWith('cad:history')));
      return { ok: true };
    });
    writes = job.catch(() => {});
    return job;
  }
  if (!Number.isInteger(message?.tabId)) return { ok: false, error: { code: 'NO_CONVERSATION' } };
  const tab = await chrome.tabs.get(message.tabId);
  if (!tab.url || new URL(tab.url).origin !== Config.ORIGIN) return { ok: false, error: { code: 'NO_CONVERSATION' } };
  if (message.type === 'RELOAD_PAGE') { await chrome.tabs.reload(tab.id); return { ok: true }; }
  if (message.type === 'UI_COMMAND') {
    const command = Protocol.command(message.command);
    if (!command) return { ok: false, error: { code: 'INVALID_FILE' } };
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_COMMAND', command }, { frameId: 0 });
      return { ok: result?.ok === true,
        ...(result?.state ? { state: Safety.state(result.state) } : {}),
        ...(result?.error ? { error: Safety.error(result.error) } : {}),
        storageError: result?.storageError === true };
    } catch { return { ok: false, error: { code: 'BRIDGE' } }; }
  }
  return { ok: false };
}
const MESSAGE_TYPES = new Set(['SAVE_HISTORY', 'LOAD_HISTORY', 'OPEN_VIEW', 'SET_INCLUDE_TRANSCRIPT', 'ACK_DOWNLOADS',
  'CLEAR_HISTORY', 'RELOAD_PAGE', 'UI_COMMAND']);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Leave every other message (the Claude half, the backup popup) to its own listener.
  if (!MESSAGE_TYPES.has(message?.type)) return false;
  void route(message, sender).then(reply, () => reply({ ok: false, error: { code: 'STORAGE' } }));
  return true;
});
