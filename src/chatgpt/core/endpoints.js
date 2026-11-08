const Endpoints = (() => {
  function list(conversationId, page = null) {
    const url = new URL(`/backend-api/conversations/${encodeURIComponent(conversationId)}/files`, Config.ORIGIN);
    url.searchParams.set('limit', String(Config.FILE_LIST_LIMIT));
    if (page?.kind === 'cursor') url.searchParams.set('cursor', page.value);
    if (page?.kind === 'offset') url.searchParams.set('offset', String(page.value));
    return url.href;
  }
  function conversation(conversationId) {
    return new URL(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, Config.ORIGIN).href;
  }
  function download(conversationId, fileId) {
    const url = new URL(`/backend-api/files/download/${encodeURIComponent(fileId)}`, Config.ORIGIN);
    url.searchParams.set('check_context_scopes_for_conversation_id', conversationId);
    url.searchParams.set('download_intent', 'true');
    return url.href;
  }
  function safeDownload(value) {
    if (typeof value !== 'string' || value.length > 16384) throw new Transfer.Fault('UNSAFE_URL');
    let url;
    try { url = new URL(value, Config.ORIGIN); } catch { throw new Transfer.Fault('UNSAFE_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
      throw new Transfer.Fault('UNSAFE_URL');
    }
    if (url.origin === Config.ORIGIN) {
      if (!url.pathname.startsWith('/backend-api/')) throw new Transfer.Fault('UNSAFE_URL');
    } else {
      // Only known OpenAI file delivery hosts. No arbitrary URLs from page commands.
      const host = url.hostname;
      const allowed = host.endsWith('.oaiusercontent.com') ||
        /^(?:oai)?sdmntpr[a-z0-9-]*\.blob\.core\.windows\.net$/.test(host) ||
        /^(?:oai)?sdmntpr[a-z0-9-]*\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(host);
      if (!allowed) throw new Transfer.Fault('UNSAFE_URL');
    }
    return url;
  }
  function linkDownload(value) {
    // Last resort when a storage host refuses page fetches (CORS): let Chrome fetch the signed
    // link itself. Allowed only when the link forces an attachment download, so the ChatGPT
    // tab cannot be navigated away by a viewable response.
    let url;
    try { url = safeDownload(value); } catch { return false; }
    if (url.origin === Config.ORIGIN) return false;
    const disposition = url.searchParams.get('rscd') || url.searchParams.get('response-content-disposition') || '';
    return /^\s*attachment\b/i.test(disposition);
  }
  function nextPage(data, returned) {
    const candidates = [data, data?.pagination, data?.meta, data?.data, data?.data?.pagination].filter(v => v && typeof v === 'object');
    for (const value of candidates) {
      if (value.has_more === false || value.has_next_page === false) return { page: null, partial: false };
      if (typeof value.next_cursor === 'string' && value.next_cursor.length > 0 && value.next_cursor.length < 2048) {
        return { page: { kind: 'cursor', value: value.next_cursor }, partial: false };
      }
      if (Number.isSafeInteger(value.next_offset) && value.next_offset > 0) {
        return { page: { kind: 'offset', value: value.next_offset }, partial: false };
      }
    }
    // Unknown next links are not followed or silently reinterpreted.
    const signaled = candidates.some(v => v.has_more === true || v.has_next_page === true || v.next || v.next_page || v.next_cursor);
    return { page: null, partial: !!signaled || returned >= Config.FILE_LIST_LIMIT };
  }
  return Object.freeze({ list, conversation, download, safeDownload, linkDownload, nextPage });
})();
