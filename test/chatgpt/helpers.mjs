import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { webcrypto } from 'node:crypto';
const sourceFiles = ['config', 'safety', 'protocol', 'endpoints', 'auth', 'transfer', 'files', 'transcript', 'controller'];
export const source = (await Promise.all(sourceFiles.map(file => readFile(new URL(`../../src/chatgpt/core/${file}.js`, import.meta.url), 'utf8')))).join('\n');
export function core(extra = {}) {
  const context = vm.createContext({ URL, Request, Headers, Response, Blob, ReadableStream, TextEncoder, TextDecoder,
    AbortController, DOMException, crypto: webcrypto, structuredClone, console, setTimeout, clearTimeout, ...extra });
  return vm.runInContext(`${source}\n({ Config, Safety, Protocol, Endpoints, Authentication, Transfer, AttachmentFiles, Transcript, JobController })`, context);
}
export function plain(value) { return JSON.parse(JSON.stringify(value)); }
export async function until(predicate, message = 'Condition did not become true', attempts = 200) {
  for (let index = 0; index < attempts; index++) { if (predicate()) return; await delay(5); }
  throw new Error(message);
}
export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
export function authenticated(modules, onChange = () => {}) {
  const auth = modules.Authentication.create(onChange);
  auth.observe('https://chatgpt.com/backend-api/me', { headers: { authorization: 'Bearer TEST_ONLY_NOT_REAL', 'oai-device-id': 'TEST_DEVICE_PRIVATE' } });
  return auth;
}
export function jobHarness(fetcher, options = {}) {
  const modules = core();
  const events = [], saves = [], waits = [];
  let location = 'https://chatgpt.com/c/A';
  let job;
  const auth = authenticated(modules, () => job?.authChanged());
  job = modules.JobController.create({ auth, fetcher, href: () => location, title: () => 'Fixture conversation',
    emit: state => events.push(plain(state)), save: (blob, filename) => saves.push({ blob, filename }),
    wait: async (ms, signal) => { waits.push(ms); modules.Transfer.aborted(signal); }, ...options });
  const command = (type, extra = {}) => job.command({ type, conversationId: modules.Safety.conversation(location), ...extra });
  return { ...modules, auth, job, command, events, saves, waits,
    navigate: url => { location = url; job.navigate(); },
    setLocation: url => { location = url; },
    scan: async () => { command('SCAN_FILES'); await until(() => job.snapshot().scan.status !== 'scanning'); },
    finish: () => until(() => !['running'].includes(job.snapshot().batch.status)),
  };
}
