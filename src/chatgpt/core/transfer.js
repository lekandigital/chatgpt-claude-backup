const Transfer = (() => {
  class Fault extends Error {
    constructor(code, details = {}) {
      super(Object.hasOwn(Safety.ERRORS, code) ? code : 'UNEXPECTED');
      this.name = 'DownloadFault';
      this.code = this.message;
      if (code === 'SIZE_MISMATCH') { this.expected = Safety.size(details.expected); this.actual = Safety.size(details.actual); }
    }
  }
  function aborted(signal) { if (signal?.aborted) throw new Fault('STOPPED'); }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Fault('STOPPED')); return; }
      const timer = setTimeout(done, ms);
      function done() { signal?.removeEventListener('abort', stop); resolve(); }
      function stop() { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(new Fault('STOPPED')); }
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
  function retryAfter(value, attempt, now = Date.now()) {
    if (value && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Math.max(1000, Number(value) * 1000);
    const date = value ? Date.parse(value) : NaN;
    return Number.isFinite(date) ? Math.max(1000, date - now) : 30000 * attempt;
  }
  async function backoff(ms, signal, wait = sleep) {
    // Chunk extremely long Retry-After values to avoid the timer's 32-bit overflow.
    let remaining = ms;
    while (remaining > 0) { const chunk = Math.min(remaining, 60000); await wait(chunk, signal); remaining -= chunk; }
    aborted(signal);
  }
  function create({ fetcher, auth, guard, onWait = () => {}, onRequest = () => {}, wait = sleep,
    stallMs = Config.STALL_TIMEOUT_MS }) {
    async function request(value, signal, consume) {
      const url = Endpoints.safeDownload(value);
      const internal = url.origin === Config.ORIGIN;
      let rateRetries = 0, serverRetries = 0, networkRetries = 0;
      for (;;) {
        aborted(signal); guard();
        const context = internal ? auth.get() : { headers: new Headers(), version: null };
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal.addEventListener('abort', cancel, { once: true });
        let timedOut = false;
        let timer = null;
        // Restarted whenever response bytes arrive, so only a stalled transfer times out.
        const touch = () => {
          clearTimeout(timer);
          timer = setTimeout(() => { timedOut = true; controller.abort(); }, stallMs);
        };
        touch();
        let retry = null;
        try {
          onRequest();
          let followed = false;
          let response = await fetcher(url.href, internal ? {
            method: 'GET', headers: context.headers, credentials: 'include', cache: 'no-store',
            // Auto-following could forward account headers to another origin, so an HTTP
            // redirect is only detected here and then followed with the bearer header alone.
            redirect: 'manual', signal: controller.signal,
          } : {
            // Signed storage links carry their own authorization: no headers, cookies or referrer.
            method: 'GET', headers: context.headers, credentials: 'omit', cache: 'no-store',
            referrerPolicy: 'no-referrer', redirect: 'follow', signal: controller.signal,
          });
          if (internal && response.type === 'opaqueredirect') {
            // Browsers strip Authorization when a redirect leaves chatgpt.com; nothing else is sent.
            followed = true;
            response = await fetcher(url.href, {
              method: 'GET', headers: new Headers({ authorization: context.headers.get('authorization') }),
              credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'follow', signal: controller.signal,
            });
          }
          aborted(signal); guard();
          if (response.redirected) {
            try { Endpoints.safeDownload(response.url); }
            catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
          }
          if (response.status === 401) {
            // Only a direct ChatGPT 401 means the page credential expired. Storage hosts and
            // bearer-only redirect follow-ups fail just this file.
            if (!internal || followed) throw new Fault('HTTP_OTHER');
            auth.invalidate(context.version);
            throw new Fault('AUTH_EXPIRED');
          }
          if (response.status === 403) throw new Fault('HTTP_403');
          if (response.status === 404) throw new Fault('HTTP_404');
          if (response.status === 429) {
            if (rateRetries >= Config.MAX_RATE_RETRIES) throw new Fault('HTTP_429');
            retry = { kind: 'rate_limit', ms: retryAfter(response.headers.get('retry-after'), ++rateRetries) };
          } else if (response.status >= 500) {
            if (serverRetries >= Config.MAX_SERVER_RETRIES) throw new Fault('HTTP_5XX');
            retry = { kind: 'retry', ms: 2000 * 2 ** serverRetries++ };
          } else if (!response.ok) throw new Fault('HTTP_OTHER');
          if (!retry) {
            const result = await consume(response, controller.signal, touch);
            aborted(signal); guard();
            return result;
          }
          // Release error response bodies without reading or exposing them.
          await response.body?.cancel().catch(() => {});
        } catch (error) {
          aborted(signal); guard();
          if (error instanceof Fault) throw error;
          if (networkRetries >= Config.MAX_NETWORK_RETRIES) throw new Fault(timedOut ? 'TIMEOUT' : 'NETWORK');
          retry = { kind: 'retry', ms: 2000 * 2 ** networkRetries++ };
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
        }
        onWait(retry.kind, Date.now() + retry.ms);
        try { await backoff(retry.ms, signal, wait); } finally { onWait(null, null); }
      }
    }
    return Object.freeze({ request });
  }
  return Object.freeze({ Fault, aborted, sleep, retryAfter, backoff, create });
})();
