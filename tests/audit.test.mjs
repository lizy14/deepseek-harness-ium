import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPolicyAudit } from '../overlays/desktop/ium-audit.mjs';
import { buildEnvironment } from '../scripts/lib.mjs';

const base = fileURLToPath(new URL('../.work/audit-tests/', import.meta.url));
fs.mkdirSync(base, { recursive: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(base, 'case-'));
  t.after(() => {
    const resolved = fs.realpathSync.native(directory);
    if (path.dirname(resolved) !== fs.realpathSync.native(base) || !path.basename(resolved).startsWith('case-')) throw new Error('Unexpected audit test cleanup path');
    fs.rmSync(resolved, { recursive: true });
  });
  return { directory, file: path.join(directory, 'logs/network-policy-blocks.jsonl') };
}

test('audit retains only timestamp, mechanism and hostname', t => {
  const { directory, file } = fixture(t);
  const audit = createPolicyAudit(directory);
  audit({ mechanism: 'undici.dispatch', hostname: 'api.deepseek.com', url: 'https://user:example@api.deepseek.com/path?token=example', body: 'private fixture body' });
  const line = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(line).sort(), ['hostname', 'mechanism', 'time']);
  assert.equal(line.hostname, 'api.deepseek.com');
  assert.match(line.time, /^\d{4}-\d{2}-\d{2}T/);
  audit({ mechanism: 'fetch', hostname: 'user:example@api.deepseek.com/path' });
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('audit stops appending at its local capacity limit', t => {
  const { directory, file } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024, 32));
  createPolicyAudit(directory)({ mechanism: 'fetch', hostname: 'deepseek.com' });
  assert.equal(fs.statSync(file).size, 1024 * 1024);
});

test('audit refuses an implicit relative data directory', () => {
  assert.throws(() => createPolicyAudit('.dsh'), /absolute Harness home/);
});

test('build checks do not generate distributable Python bytecode with host paths', () => {
  const previous = process.env.PYTHONDONTWRITEBYTECODE;
  const env = buildEnvironment();
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(process.env.PYTHONDONTWRITEBYTECODE, previous);
});
