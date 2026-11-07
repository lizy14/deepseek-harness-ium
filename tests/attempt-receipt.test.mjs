import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { beginAttempt } from '../scripts/attempt-receipt.mjs';
import { compileArtifacts } from '../scripts/compile.mjs';
import { buildWindows } from '../scripts/build-windows.mjs';
import { verifyPackaged } from '../scripts/verify-packaged.mjs';

const base = fileURLToPath(new URL('../.work/receipt-tests/', import.meta.url));
fs.mkdirSync(base, { recursive: true });
const version = '0.2.2-rc.1.20261107.1';
const digest = 'a'.repeat(64);
const hash = data => createHash('sha256').update(data).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const profile = { identity: { packageName: '@lizy14/dsh-desktop-ium', productName: 'DSH Ium', appId: 'io.github.lizy14.dshium' } };
const deployment = Buffer.from('- id: fixture\n  disabled: true\n');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(base, 'case-'));
  const rootDirectory = path.join(directory, 'recipe');
  const workDirectory = path.join(directory, 'work');
  const upstreamDirectory = path.join(workDirectory, 'upstream');
  fs.mkdirSync(path.join(upstreamDirectory, 'apps/desktop'), { recursive: true });
  write(path.join(rootDirectory, 'profiles/work.json'), profile);
  fs.writeFileSync(path.join(rootDirectory, 'profiles/work.cordis.yml'), deployment);
  write(path.join(rootDirectory, 'release-plan.json'), { version });
  write(path.join(workDirectory, 'source-verification.json'), { sourceVerified: true, sourceInputSha256: digest, upstreamCommit: 'b'.repeat(40) });
  const receipts = Object.fromEntries(['build-result', 'compile-result', 'packaged-verification'].map(name => [name, path.join(workDirectory, name + '.json')]));
  for (const file of Object.values(receipts)) write(file, { result: 'PASS', attemptId: 'old-attempt', artifactHashes: { stale: 'c'.repeat(64) }, staticPackagedChecksPassed: true });
  t.after(() => {
    const resolved = fs.realpathSync.native(directory);
    if (path.dirname(resolved) !== fs.realpathSync.native(base) || !path.basename(resolved).startsWith('case-')) throw new Error('Unexpected receipt fixture cleanup path');
    fs.rmSync(resolved, { recursive: true });
  });
  return {
    directory, rootDirectory, workDirectory, upstreamDirectory, receipts, quiet: true,
    readLock: () => ({ version: '0.2.2-rc.1', commit: 'b'.repeat(40), toolchain: { node: process.versions.node } }),
    makeEnvironment: () => ({}), resolvePnpm: () => 'fixture-pnpm', platform: 'win32', architecture: 'x64',
  };
}

function artifact(f, { packageVersion = version, missingChunk = false, corruptChunk = false } = {}) {
  const directory = path.join(f.upstreamDirectory, 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked');
  const files = {
    'package.json': JSON.stringify({ name: profile.identity.packageName, main: 'lib/ium-bootstrap.js', dshDesktopAppId: profile.identity.appId, version: packageVersion }),
    'lib/ium-bootstrap.js': `import{audit}from'./ium-audit-fixture.js';\n// ium-network-policy.js data:,ium-policy-initialize main.js\n`,
    'lib/ium-node-preload.js': `import './ium-audit-fixture.js';\n// ium-network-policy.js data:,ium-policy-initialize\n`,
    'lib/ium-network-policy.js': '// deepseek.com deepseeksvc.com ERR_IUM_NETWORK_BLOCKED\n',
    'node_modules/undici/package.json': JSON.stringify({ version: '7.29.1' }),
    'dsh/node_modules/@deepseek-ai/dsh-desktop-host/ium-work.cordis.yml': deployment,
  };
  if (!missingChunk) files['lib/ium-audit-fixture.js'] = 'export const audit = true;\n';
  const tree = { files: {} }; const bodies = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value); const parts = name.split('/'); let cursor = tree;
    for (const part of parts.slice(0, -1)) cursor = cursor.files[part] ??= { files: {} };
    cursor.files[parts.at(-1)] = { size: bytes.length, offset: String(offset), integrity: { algorithm: 'SHA256', hash: corruptChunk && name === 'lib/ium-audit-fixture.js' ? '0'.repeat(64) : hash(bytes) } };
    bodies.push(bytes); offset += bytes.length;
  }
  const header = Buffer.from(JSON.stringify(tree));
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(8 + header.length, 4); prefix.writeUInt32LE(4 + header.length, 8); prefix.writeUInt32LE(header.length, 12);
  fs.mkdirSync(path.join(directory, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'resources/app.asar'), Buffer.concat([prefix, header, ...bodies]));
  fs.writeFileSync(path.join(directory, 'DSH Ium.exe'), 'fixture bytes, never executed');
  return directory;
}

const assertFailed = file => {
  const result = read(file);
  assert.equal(result.result, 'FAIL');
  assert.notEqual(result.attemptId, 'old-attempt');
  assert.deepEqual(result.artifactHashes, {});
  assert.equal(result.staticPackagedChecksPassed, false);
  return result;
};

test('RUNNING immediately replaces old PASS and cannot be overwritten by an older owner', t => {
  const f = fixture(t); const file = f.receipts['compile-result'];
  const first = beginAttempt(file, { kind: 'fixture' });
  assert.equal(read(file).result, 'RUNNING');
  assert.deepEqual(read(file).artifactHashes, {});
  const second = beginAttempt(file, { kind: 'fixture' });
  assert.throws(() => first.fail(new Error('late failure')), /superseded/);
  assert.equal(read(file).attemptId, second.id);
  assert.equal(read(file).result, 'RUNNING');
});

test('invalid build arguments invalidate both previous build and package PASS before any command', t => {
  const f = fixture(t); let calls = 0;
  assert.throws(() => buildWindows([], { ...f, execute: () => { calls++; } }), /build-version/);
  assert.equal(calls, 0);
  const a = assertFailed(f.receipts['build-result']); const b = assertFailed(f.receipts['packaged-verification']);
  assert.equal(a.attemptId, b.attemptId);
});

test('failed packaging command leaves FAIL rather than an old verified artifact', t => {
  const f = fixture(t);
  assert.throws(() => buildWindows(['--build-version', version, '--dir'], { ...f, execute: (_command, args) => {
    assert.equal(read(f.receipts['build-result']).result, 'RUNNING');
    assert.equal(read(f.receipts['packaged-verification']).result, 'RUNNING');
    if (args[0] === 'fixture-pnpm') throw new Error('fixture build failure');
  } }), /fixture build failure/);
  const result = assertFailed(f.receipts['build-result']); assertFailed(f.receipts['packaged-verification']);
  assert.equal(result.sourceInputSha256, digest); assert.equal(result.requestedBuildVersion, version);
});

test('failed preflight invalidates a prior packaged PASS instead of leaving it usable', t => {
  const f = fixture(t);
  assert.throws(() => buildWindows(['--build-version', version, '--check'], { ...f, execute: (_command, args) => {
    if (args[0] === 'fixture-pnpm') throw new Error('fixture preflight failure');
  } }), /fixture preflight failure/);
  assertFailed(f.receipts['build-result']); assertFailed(f.receipts['packaged-verification']);
});

test('successful preflight is PASS only for the check and marks package verification NOT_RUN', t => {
  const f = fixture(t);
  const result = buildWindows(['--build-version', version, '--check'], { ...f, execute: () => {} });
  assert.equal(result.result, 'PASS'); assert.equal(result.mode, 'preflight');
  assert.deepEqual(result.artifactHashes, {});
  assert.equal(read(f.receipts['packaged-verification']).result, 'NOT_RUN');
  assert.equal(read(f.receipts['packaged-verification']).attemptId, result.attemptId);
});

test('a successful command without a current package verification receipt cannot reuse old PASS', t => {
  const f = fixture(t);
  assert.throws(() => buildWindows(['--build-version', version, '--dir'], { ...f, execute: () => {} }), /does not match this build attempt/);
  assertFailed(f.receipts['build-result']); assertFailed(f.receipts['packaged-verification']);
});

test('successful build binds the child verification to its own attempt, source, requested version and hashes', t => {
  const f = fixture(t); artifact(f);
  const result = buildWindows(['--build-version', version, '--dir'], { ...f, execute: (_command, args) => {
    if (args[0] === path.join(f.rootDirectory, 'scripts/verify-packaged.mjs')) verifyPackaged(args.slice(1), f);
  } });
  const verified = read(f.receipts['packaged-verification']);
  assert.equal(result.result, 'PASS'); assert.equal(verified.attemptId, result.attemptId);
  assert.equal(result.sourceInputSha256, digest); assert.equal(result.requestedBuildVersion, version);
  assert.deepEqual(result.artifactHashes, verified.artifactHashes);
  assert.equal(result.nativeDesktopAcceptancePassed, false);
});

test('failed compile/check invalidates previous PASS before running and binds failure context', t => {
  const f = fixture(t);
  assert.throws(() => compileArtifacts({ ...f, execute: (_command, args) => {
    assert.equal(read(f.receipts['compile-result']).result, 'RUNNING');
    if (args.includes('build:check')) throw new Error('fixture check failure');
  } }), /fixture check failure/);
  const result = assertFailed(f.receipts['compile-result']);
  assert.equal(result.sourceInputSha256, digest); assert.equal(result.requestedBuildVersion, '0.2.2-rc.1');
});

test('commands returning success without compiled outputs cannot produce a compile PASS', t => {
  const f = fixture(t);
  assert.throws(() => compileArtifacts({ ...f, execute: () => {} }));
  assertFailed(f.receipts['compile-result']);
});

test('successful compilation binds both scopes and actual compiled file hashes', t => {
  const f = fixture(t); const directory = path.join(f.upstreamDirectory, 'apps/desktop/lib');
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ['main.js', 'ium-bootstrap.js', 'ium-node-preload.js', 'ium-network-policy.js', 'ium-audit-fixture.js']) fs.writeFileSync(path.join(directory, name), '// ' + name);
  const result = compileArtifacts({ ...f, execute: () => {} });
  assert.equal(result.result, 'PASS'); assert.equal(result.sourceInputSha256, digest);
  assert.deepEqual(result.scopes, ['artifacts', 'check']);
  assert.equal(Object.keys(result.artifactHashes).length, 5);
  assert.equal(result.artifactHashes['apps/desktop/lib/main.js'], hash('// main.js'));
});

test('wrong artifact version rejects and replaces old package PASS', t => {
  const f = fixture(t); const directory = artifact(f, { packageVersion: '0.2.2-rc.1.20261106.1' });
  assert.throws(() => verifyPackaged([directory, '--build-version', version], f), /does not equal requested/);
  const result = assertFailed(f.receipts['packaged-verification']);
  assert.equal(result.requestedBuildVersion, version); assert.equal(result.sourceInputSha256, digest);
});

test('missing static relative Ium audit chunk rejects despite all three entries existing', t => {
  const f = fixture(t); const directory = artifact(f, { missingChunk: true });
  assert.throws(() => verifyPackaged([directory, '--build-version', version], f), /Missing packed entry: lib\/ium-audit-fixture.js/);
  assertFailed(f.receipts['packaged-verification']);
});

test('corrupt static chunk fails its original ASAR integrity check', t => {
  const f = fixture(t); const directory = artifact(f, { corruptChunk: true });
  assert.throws(() => verifyPackaged([directory, '--build-version', version], f), /Entry integrity mismatch/);
  assertFailed(f.receipts['packaged-verification']);
});

test('legacy directory call uses the explicit release plan and records static chunk hashes', t => {
  const f = fixture(t); const directory = artifact(f);
  const result = verifyPackaged([directory], f);
  assert.equal(result.result, 'PASS'); assert.equal(result.version, version); assert.equal(result.requestedBuildVersion, version);
  assert.equal(result.sourceInputSha256, digest);
  assert.match(result.archiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.artifactHashes['asar:lib/ium-audit-fixture.js'], hash('export const audit = true;\n'));
  assert.ok(result.checkedRelativeModules.includes('lib/ium-audit-fixture.js'));
  assert.equal(result.nativeDesktopAcceptancePassed, false);
});

test('source mismatch cannot generate a PASS for an otherwise valid artifact', t => {
  const f = fixture(t); const directory = artifact(f);
  assert.throws(() => verifyPackaged([directory, '--build-version', version, '--source-input-sha256', 'd'.repeat(64)], f), /differs from verified/);
  assertFailed(f.receipts['packaged-verification']);
});
