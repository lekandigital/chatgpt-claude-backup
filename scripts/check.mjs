// Static checks for the whole extension: manifest references, syntax, versions, page CSP rules.
import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(manifest.version, version, 'manifest.json and package.json versions differ');
assert.ok((await readFile('src/chatgpt/core/config.js', 'utf8')).includes(`VERSION: '${version}'`), 'src/chatgpt/core/config.js VERSION must match package.json');
assert.deepEqual(manifest.host_permissions, ['https://claude.ai/*', 'https://api.claude.ai/*', 'https://chatgpt.com/*']);
assert.equal(manifest.web_accessible_resources, undefined);
assert.equal(manifest.externally_connectable, undefined);
const referenced = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon), ...manifest.content_scripts.flatMap(s => s.js)];
for (const file of referenced) await access(file);
// The root worker importScripts() both halves.
const worker = await readFile('background.js', 'utf8');
for (const file of worker.match(/importScripts\(([^)]*)\)/)[1].match(/"([^"]+)"/g).map(f => f.slice(1, -1))) await access(file);

async function walk(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name.startsWith('.')) continue;
    const target = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await walk(target)); else files.push(target);
  }
  return files;
}
const all = [...await walk('.')].map(f => f.replace(/^\.\//, ''));
for (const file of all.filter(f => /\.(m?js)$/.test(f) && !f.startsWith('chatgpt-archive/'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  // The ChatGPT half keeps credentials in page memory: no dynamic code, no debug logging.
  if (file.startsWith('src/chatgpt/') || file.startsWith('chatgpt/')) {
    const code = await readFile(file, 'utf8');
    assert.ok(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(code), `${file}: dynamic code`);
    assert.ok(!/console\.(?:log|debug|info)\(/.test(code), `${file}: unsafe debug logging`);
  }
}
// Extension pages: no inline scripts or handlers (MV3 CSP would block them) and no remote resources.
for (const page of all.filter(f => f.endsWith('.html') && !f.startsWith('chatgpt-archive/') && !f.startsWith('test/') && !f.startsWith('docs/') && !f.startsWith('src/'))) {
  const html = await readFile(page, 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), `${page}: inline script`);
  assert.ok(!/\son[a-z]+=["']/i.test(html), `${page}: inline event handler`);
  assert.ok(!/(?:src|href)=["']https?:\/\//i.test(html), `${page}: remote resource`);
  for (const ref of html.matchAll(/(?:src|href)=["']([^"'#?]+)/g)) {
    if (/^(https?:|mailto:|chrome:)/.test(ref[1])) continue;
    await access(path.join(path.dirname(page), ref[1])).catch(() => assert.fail(`${page}: missing ${ref[1]}`));
  }
}
// Built ChatGPT bundles must be current (run npm run build after editing src/chatgpt).
const build = spawnSync(process.execPath, ['scripts/chatgpt/build.mjs'], { encoding: 'utf8' });
assert.equal(build.status, 0, build.stderr);
const diff = spawnSync('git', ['status', '--porcelain', '--', 'chatgpt'], { encoding: 'utf8' });
if (diff.stdout.trim()) console.warn(`Note: chatgpt/ changed after rebuilding — commit it:\n${diff.stdout}`);
console.log('Manifest, referenced files, syntax, versions and page checks passed.');
