const Protocol = (() => {
  const COMMANDS = new Set(['GET_STATUS', 'SCAN_FILES', 'START_DOWNLOADS', 'DOWNLOAD_SELECTED', 'STOP_DOWNLOADS', 'RESUME', 'RETRY_FAILED', 'EXPORT_TRANSCRIPT']);
  const TRANSCRIPT_FORMATS = new Set(['markdown', 'json']);
  function command(value, allowHistory = false) {
    if (!value || typeof value !== 'object' ||
      !(COMMANDS.has(value.type) || (allowHistory && value.type === 'RESTORE_HISTORY'))) return null;
    const result = { type: value.type, conversationId: Safety.id(value.conversationId) };
    if (!['GET_STATUS', 'STOP_DOWNLOADS'].includes(value.type) && !result.conversationId) return null;
    if (value.type === 'DOWNLOAD_SELECTED') {
      if (!Array.isArray(value.ids) || value.ids.length > Config.MAX_FILES || value.ids.some(id => !Safety.id(id, true))) return null;
      result.ids = [...new Set(value.ids)];
    }
    if (value.type === 'RESTORE_HISTORY') result.files = Safety.files(value.files);
    if (value.type === 'EXPORT_TRANSCRIPT') {
      if (!TRANSCRIPT_FORMATS.has(value.format)) return null;
      result.format = value.format;
    }
    if (value.type === 'START_DOWNLOADS') result.transcript = value.transcript === true;
    return result;
  }
  function requestId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value); }
  function envelope(value, direction) {
    return value && value.namespace === Config.NAMESPACE && value.direction === direction && requestId(value.requestId);
  }
  return Object.freeze({ COMMANDS, command, requestId, envelope });
})();
