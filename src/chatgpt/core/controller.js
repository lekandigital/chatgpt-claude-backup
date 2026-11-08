const JobController = (() => {
  function create({ auth, fetcher, href, title, emit, save, saveLink = () => { throw new Transfer.Fault('NETWORK'); }, wait = Transfer.sleep }) {
    const instanceId = crypto.randomUUID();
    let operation = null;
    let publishedAt = 0;
    let restored = new Map();
    let state = initial();
    function initial() {
      return { instanceId, conversationId: Safety.conversation(href()), title: Safety.label(title()), revision: 0,
        auth: auth.status(), scan: { status: 'idle', fresh: false, lastScannedAt: null, partial: false, shape: [] }, files: [],
        batch: { status: 'idle', total: 0, completed: 0, successful: 0, failed: 0, startedAt: null, stoppedAt: null },
        activeId: null, activeBytes: null, retryAt: null, waiting: null, largeFile: false, error: null, logs: [],
        transcript: idleTranscript() };
    }
    function idleTranscript() { return { status: 'idle', format: null, messages: 0, exportedAt: null, error: null }; }
    function log(code, error = null) {
      state.logs.push({ at: Date.now(), code, error: error ? Safety.error(error) : null });
      if (state.logs.length > 60) state.logs.shift();
    }
    function publish() {
      state.auth = auth.status();
      state.title = Safety.label(title());
      state.revision++;
      publishedAt = Date.now();
      emit(Safety.state(state));
    }
    function publishProgress() {
      // Byte counters change constantly; the bridge and storage only need a few updates a second.
      if (Date.now() - publishedAt >= Config.PROGRESS_PUBLISH_MS) publish();
    }
    function current(op) {
      return operation === op && op.conversationId === state.conversationId && op.conversationId === Safety.conversation(href());
    }
    function guard(op) {
      Transfer.aborted(op.abort.signal);
      if (!current(op)) throw new Transfer.Fault('CONVERSATION_CHANGED');
    }
    function stop() {
      if (!operation) return;
      operation.abort.abort();
      const item = state.files.find(f => f.id === state.activeId);
      if (item && item.status !== 'downloaded') { item.status = 'stopped'; item.error = null; }
      if (operation.kind === 'scan') state.scan.status = 'stopped';
      else if (operation.kind === 'batch') { state.batch.status = 'stopped'; state.batch.stoppedAt = Date.now(); }
      if (state.transcript.status === 'exporting') state.transcript.status = 'idle';
      state.retryAt = null; state.waiting = null; state.activeBytes = null;
      log('STOPPED'); publish();
    }
    function navigate() {
      if (Safety.conversation(href()) === state.conversationId) return false;
      stop();
      operation = null;
      restored = new Map();
      state = initial();
      log('CONVERSATION'); publish();
      return true;
    }
    function begin(kind) {
      if (operation) throw new Transfer.Fault('BUSY');
      if (!state.conversationId) throw new Transfer.Fault('NO_CONVERSATION');
      auth.get();
      const op = { kind, conversationId: state.conversationId, abort: new AbortController() };
      operation = op;
      state.error = null; state.largeFile = false;
      return op;
    }
    function clientFor(op, file = null) {
      let priorStatus = null;
      return Transfer.create({ fetcher, auth, guard: () => guard(op), wait,
        onRequest: () => { if (current(op) && file) file.attempts++; },
        onWait: (kind, until) => {
          if (!current(op) || op.abort.signal.aborted) return;
          state.waiting = kind; state.retryAt = until;
          if (file) {
            if (kind && !priorStatus) priorStatus = file.status;
            if (kind === 'rate_limit') file.status = 'rate_limited';
            if (!kind && priorStatus) { file.status = priorStatus; priorStatus = null; }
          }
          if (kind) log(kind === 'rate_limit' ? 'RATE_LIMIT' : 'RETRY');
          publish();
        },
      });
    }
    function unexpected(error) {
      // Name and message only, passed through the redacting sanitizer; never objects, headers or URLs.
      console.error('[ChatGPT Attachment Downloader]', Safety.text(`${error?.name || 'Error'}: ${error?.message || ''}`));
      return { code: 'UNEXPECTED' };
    }
    function recordError(error, perFile = false) {
      const clean = error instanceof Transfer.Fault ? Safety.error(error) : unexpected(error);
      // A single file's failure is shown on its row; the banner is for problems that stop the job.
      if (!perFile || ['AUTH_EXPIRED', 'AUTH_WAITING'].includes(clean.code)) state.error = clean;
      log('ERROR', clean);
      return clean;
    }
    async function scan(op) {
      try {
        const result = await AttachmentFiles.scan(clientFor(op), op.conversationId, op.abort.signal, shape => {
          if (current(op)) state.scan.shape = shape;
        });
        guard(op);
        const history = new Map([...restored, ...state.files.map(file => [file.id, file])]);
        state.files = result.files.map(file => {
          const previous = history.get(file.id);
          if (!previous) return file;
          const status = ['resolving', 'downloading', 'rate_limited'].includes(previous.status) ? 'stopped' : previous.status;
          return { ...file, status, actualSize: previous.actualSize, verified: previous.verified,
            attempts: previous.attempts, error: previous.error, completedAt: previous.completedAt };
        });
        state.scan = { status: 'completed', fresh: true, lastScannedAt: Date.now(), partial: result.partial, shape: state.scan.shape };
        state.batch = { status: 'idle', total: 0, completed: 0, successful: 0, failed: 0, startedAt: null, stoppedAt: null };
        log('SCAN_DONE');
      } catch (error) {
        if (!current(op)) return;
        state.scan.status = op.abort.signal.aborted ? 'stopped' : 'failed';
        if (!op.abort.signal.aborted) recordError(error);
      } finally {
        if (current(op)) { operation = null; state.retryAt = null; state.waiting = null; publish(); }
      }
    }
    async function saveTranscript(op, format) {
      // Downloaded attachments are linked by their saved names, so the transcript works beside them.
      const names = new Map(state.files.filter(f => f.status === 'downloaded').map(f => [f.id, f.filename]));
      state.transcript = { ...idleTranscript(), status: 'exporting', format };
      publish();
      try {
        const data = await clientFor(op).request(Endpoints.conversation(op.conversationId), op.abort.signal, async (response, signal, touch) => {
          if (/html/i.test(response.headers.get('content-type') || '')) throw new Transfer.Fault('HTML_RESPONSE');
          const text = await (await AttachmentFiles.readBody(response, 'application/json', touch)).text();
          try { return JSON.parse(text); } catch { throw new Transfer.Fault('API_CHANGED'); }
        });
        guard(op);
        if (!Transcript.isConversation(data)) throw new Transfer.Fault('API_CHANGED');
        const rendered = Transcript.render(data, { conversationId: op.conversationId, names });
        const markdown = format === 'markdown';
        const extension = markdown ? 'md' : 'json';
        // JSON is the API response unchanged: every branch and all metadata, for archiving.
        const blob = new Blob([markdown ? rendered.markdown : JSON.stringify(data, null, 2)], { type: markdown ? 'text/markdown' : 'application/json' });
        const filename = Safety.filename(`${rendered.title} (transcript).${extension}`, `ChatGPT conversation (transcript).${extension}`);
        guard(op);
        save(blob, filename);
        state.transcript = { status: 'saved', format, messages: rendered.messages, exportedAt: Date.now(), error: null };
        log('TRANSCRIPT_SAVED');
      } catch (error) {
        // Stop and navigation are handled by the caller; anything else fails only the transcript.
        if (!current(op) || op.abort.signal.aborted) throw error;
        state.transcript = { ...state.transcript, status: 'failed', error: recordError(error, true) };
      }
    }
    async function transcriptOnly(op, format) {
      try { await saveTranscript(op, format); }
      catch { /* Stopped or navigated away: stop() and navigate() already updated the state. */ }
      finally { if (current(op)) { operation = null; state.retryAt = null; state.waiting = null; publish(); } }
    }
    async function batch(op, queue) {
      const usedNames = new Set(state.files.filter(f => f.status === 'downloaded').map(f => f.filename.toLowerCase()));
      function uniqueName(name) {
        let candidate = name;
        const extension = name.match(/\.[^./]+$/)?.[0] || '';
        let stem = extension ? name.slice(0, -extension.length) : name;
        // Leave room for a suffix so filename truncation cannot remove it and loop forever.
        while (new TextEncoder().encode(stem).length > 170) stem = Array.from(stem).slice(0, -1).join('');
        let suffix = 2;
        while (usedNames.has(candidate.toLowerCase())) candidate = Safety.filename(`${stem} (${suffix++})${extension}`);
        usedNames.add(candidate.toLowerCase());
        return candidate;
      }
      try {
        for (let index = 0; index < queue.length; index++) {
          guard(op);
          const file = queue[index];
          state.activeId = file.id; state.activeBytes = null; file.status = 'resolving'; file.error = null;
          state.largeFile = (file.expectedSize || 0) > Config.LARGE_FILE_BYTES;
          publish();
          try {
            const result = await AttachmentFiles.resolve(clientFor(op, file), op.conversationId, file, op.abort.signal, (progress, bytes) => {
              if (!current(op) || op.abort.signal.aborted) return;
              if (progress === 'bytes') { state.activeBytes = bytes; publishProgress(); return; }
              if (progress === 'resolving') state.activeBytes = null;
              if (progress === 'metadata') log('METADATA');
              else if (progress === 'size_retry') log('SIZE_RETRY');
              else if (progress === 'large') state.largeFile = true;
              else file.status = progress;
              publish();
            });
            guard(op);
            const outputName = uniqueName(result.filename);
            // No await between the final navigation/abort check and the anchor click.
            if (result.link) saveLink(result.link, outputName); else save(result.blob, outputName);
            file.delivery = result.link ? 'link' : null;
            file.filename = outputName;
            file.expectedSize = result.expectedSize;
            file.actualSize = result.actualSize;
            file.mime = result.mime;
            file.verified = result.verified;
            file.status = 'downloaded';
            file.completedAt = Date.now();
            state.batch.successful++;
            log(result.link ? 'LINK_SAVED' : 'FILE_SAVED');
          } catch (error) {
            if (!current(op)) return;
            if (op.abort.signal.aborted) { file.status = 'stopped'; file.error = null; throw new Transfer.Fault('STOPPED'); }
            const clean = recordError(error, true);
            file.error = clean;
            if (clean.code === 'AUTH_EXPIRED' || clean.code === 'AUTH_WAITING') {
              file.status = 'stopped'; state.batch.status = 'paused';
              break;
            }
            file.status = 'failed'; state.batch.failed++;
          }
          state.batch.completed++;
          state.activeId = null; state.activeBytes = null;
          publish();
          if (index < queue.length - 1) await wait(Config.FILE_DELAY_MS, op.abort.signal);
        }
        if (current(op) && state.batch.status === 'running') {
          if (op.transcript) {
            if (queue.length) await wait(Config.FILE_DELAY_MS, op.abort.signal);
            await saveTranscript(op, 'markdown');
          }
          state.batch.status = 'completed'; log('COMPLETED');
        }
      } catch (error) {
        if (!current(op)) return;
        if (op.abort.signal.aborted || error.code === 'STOPPED') state.batch.status = 'stopped';
        else { recordError(error); state.batch.status = 'paused'; }
      } finally {
        if (current(op)) {
          operation = null; state.activeId = null; state.activeBytes = null; state.retryAt = null; state.waiting = null;
          state.batch.stoppedAt = Date.now(); publish();
        }
      }
    }
    function command(raw) {
      navigate();
      const cmd = Protocol.command(raw, true);
      if (!cmd) return { ok: false, error: { code: 'INVALID_FILE' } };
      try {
        if (cmd.type === 'GET_STATUS') {
          state.title = Safety.label(title());
          return { ok: true, state: Safety.state(state) };
        }
        // STOP is scoped too: a stale popup cannot stop a newly navigated conversation.
        if (cmd.conversationId !== state.conversationId) throw new Transfer.Fault('CONVERSATION_CHANGED');
        if (cmd.type === 'STOP_DOWNLOADS') { stop(); return { ok: true, state: Safety.state(state) }; }
        if (cmd.type === 'RESTORE_HISTORY') {
          if (!operation && !state.scan.fresh) restored = new Map(cmd.files.map(f => [f.id, f]));
          return { ok: true };
        }
        if (cmd.type === 'SCAN_FILES') {
          const op = begin('scan');
          state.scan.status = 'scanning'; state.scan.fresh = false; state.scan.shape = [];
          log('SCAN_START'); publish();
          void scan(op);
          return { ok: true, state: Safety.state(state) };
        }
        if (cmd.type === 'EXPORT_TRANSCRIPT') {
          const op = begin('transcript');
          void transcriptOnly(op, cmd.format);
          return { ok: true, state: Safety.state(state) };
        }
        if (!state.scan.fresh) throw new Transfer.Fault('SCAN_REQUIRED');
        let queue;
        if (cmd.type === 'DOWNLOAD_SELECTED') {
          const ids = new Set(cmd.ids);
          if (cmd.ids.some(id => !state.files.some(f => f.id === id))) throw new Transfer.Fault('INVALID_FILE');
          queue = state.files.filter(f => ids.has(f.id));
        } else if (cmd.type === 'RETRY_FAILED') queue = state.files.filter(f => f.status === 'failed');
        else queue = state.files.filter(f => ['pending', 'stopped', 'failed'].includes(f.status));
        const withTranscript = cmd.type === 'START_DOWNLOADS' && cmd.transcript === true;
        if (!queue.length && withTranscript) {
          // Everything is already downloaded; the transcript alone was requested.
          void transcriptOnly(begin('transcript'), 'markdown');
          return { ok: true, state: Safety.state(state) };
        }
        if (!queue.length) return { ok: true, state: Safety.state(state) };
        const op = begin('batch');
        op.transcript = withTranscript;
        state.batch = { status: 'running', total: queue.length, completed: 0, successful: 0, failed: 0, startedAt: Date.now(), stoppedAt: null };
        log('BATCH_START'); publish();
        void batch(op, queue);
        return { ok: true, state: Safety.state(state) };
      } catch (error) {
        const clean = error instanceof Transfer.Fault ? Safety.error(error) : unexpected(error);
        return { ok: false, error: clean, state: Safety.state(state) };
      }
    }
    function authChanged() { log(auth.status().detected ? 'AUTH_READY' : 'AUTH_EXPIRED'); publish(); }
    return Object.freeze({ command, navigate, stop, authChanged, snapshot: () => Safety.state(state) });
  }
  return Object.freeze({ create });
})();
