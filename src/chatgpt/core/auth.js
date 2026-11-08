const Authentication = (() => {
  // Stable account/client identity only. Per-request headers (trace IDs, target paths, sentinel tokens) are never replayed.
  const REPLAY_HEADERS = new Set(['authorization', 'oai-device-id', 'oai-session-id', 'oai-language', 'oai-account-id',
    'chatgpt-account-id', 'openai-organization', 'openai-project', 'oai-client-version', 'oai-client-build-number']);
  function create(onChange) {
    // This closure is instantiated only in MAIN. None of these values are exported to the bridge.
    let captured = null;
    let version = 0;
    let expired = false;
    function observe(input, init) {
      const url = new URL(input instanceof Request ? input.url : input, typeof location !== 'undefined' ? location.href : Config.ORIGIN);
      if (url.origin !== Config.ORIGIN || !url.pathname.startsWith('/backend-api/')) return;
      // RequestInit.headers replaces Request.headers; it does not merge with them.
      const source = init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined;
      const headers = new Headers(source);
      if (!headers.get('authorization')) return;
      const next = new Headers();
      for (const name of REPLAY_HEADERS) if (headers.has(name)) next.set(name, headers.get(name));
      // ChatGPT sends many authenticated requests; only a readiness transition is worth announcing.
      const changed = !captured;
      captured = next;
      version += 1;
      expired = false;
      if (changed) onChange?.();
    }
    function get() {
      if (!captured) throw new Transfer.Fault(expired ? 'AUTH_EXPIRED' : 'AUTH_WAITING');
      return { headers: new Headers(captured), version };
    }
    function invalidate(requestVersion) {
      // A late 401 from the previous credential must not erase a newer observed credential.
      if (requestVersion === version) { captured = null; expired = true; onChange?.(); }
    }
    function clear() { captured = null; expired = false; version += 1; onChange?.(); }
    function status() { return { detected: !!captured, expired }; }
    return Object.freeze({ observe, get, invalidate, clear, status });
  }
  function wrap(target, auth) {
    const previous = target.fetch;
    const wrapper = function (...args) {
      try { auth.observe(args[0], args[1]); } catch { /* Observation must never change a page request. */ }
      return Reflect.apply(previous, this, args);
    };
    target.fetch = wrapper;
    // Downloader calls use the prior wrapper so they are not mistaken for fresh page authentication.
    return (...args) => Reflect.apply(previous, target, args);
  }
  return Object.freeze({ create, wrap });
})();
