import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  hash, isDeepSeek, routeSummary, newRunDirectory, writeResult, parseDevToolsPort, assertOwnedCdpPid,
  readAudit, summarizeDom, assessRun, startOfflineServices, isolatedEnvironment, readArtifactIdentity, validateIdentity,
} from './helpers.mjs';
import { runGuiSmoke, revealSidebarNavigation, waitForEnabledControl } from '../../../scripts/gui-smoke.mjs';

const recipe = fileURLToPath(new URL('../../../', import.meta.url));
const base = path.join(process.env.IUM_WORK_DIR ?? path.join(recipe, '.work'), 'gui-smoke-fixture-tests');
fs.mkdirSync(base, { recursive: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(base, 'case-'));
  t.after(() => {
    const resolved = fs.realpathSync.native(directory);
    if (path.dirname(resolved) !== fs.realpathSync.native(base) || !path.basename(resolved).startsWith('case-')) throw new Error('Refusing unexpected GUI fixture cleanup');
    fs.rmSync(resolved, { recursive: true });
  });
  return directory;
}
function validRun() {
  const common = { rootPresent: true, rootVisible: true, rootInert: false, forcedLogin: [] };
  return {
    exit: { closed: true, status: 0, signal: null, spawnError: null, forced: false, premature: false, timedOut: false },
    ready: true, artifactUnchanged: true, audit: { present: false, records: [], attempts: 0 }, proxy: { records: [] }, cdpAttempts: [],
    ui: {
      main: { ...common, pluginsReachable: true, settingsReachable: true },
      plugins: { ...common, headingVisible: true, addControlVisible: true, addControlEnabled: true },
      models: { ...common, rootInert: true, dialogVisible: true, selected: true, headingVisible: true, accountControlVisible: false },
    },
  };
}
function request(url, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { path: requestPath, method: 'GET' }, response => {
      let text = ''; response.on('data', chunk => text += chunk); response.once('end', () => resolve({ status: response.statusCode, text }));
    });
    req.once('error', reject); req.setTimeout(3000, () => req.destroy(new Error('Fixture request timeout'))); req.end();
  });
}

test('domain classifier uses suffix boundaries and does not transmit a request', () => {
  assert.equal(isDeepSeek('API.DeepSeek.com.'), true);
  assert.equal(isDeepSeek('https://otel.deepseeksvc.com/path?token=fixture'), true);
  assert.equal(isDeepSeek('deepseek.com.example.test'), false);
  assert.equal(isDeepSeek('github.com'), false);
  assert.deepEqual(routeSummary('http://127.0.0.1:123/path?token=fixture#secret'), { protocol: 'http:', hostname: '127.0.0.1', pathname: '/path' });
});
test('CDP port file must name a loopback browser endpoint', () => {
  assert.equal(parseDevToolsPort('12345\n/devtools/browser/abc-123\n').url, 'ws://127.0.0.1:12345/devtools/browser/abc-123');
  for (const text of ['0\n/devtools/browser/x', '123\nhttps://outside.example.test/', '123', '70000\n/devtools/browser/a']) assert.throws(() => parseDevToolsPort(text));
});
test('CDP identity must match the launched primary PID', () => {
  assert.equal(assertOwnedCdpPid({ processInfo: [{ type: 'browser', id: 123 }] }, 123), 123);
  assert.throws(() => assertOwnedCdpPid({ processInfo: [{ type: 'browser', id: 987 }, { type: 'renderer', id: 123 }] }, 123));
  assert.throws(() => assertOwnedCdpPid({ processInfo: [] }, 123));
});
test('fresh runs never reuse a previous result directory', t => {
  const directory = fixture(t), a = newRunDirectory(directory), b = newRunDirectory(directory);
  assert.notEqual(a, b);
  writeResult(path.join(a, 'gui-smoke-result.json'), { result: 'PASS' });
  assert.equal(fs.existsSync(path.join(b, 'gui-smoke-result.json')), false);
});
test('production audit attempts are failures even when the policy blocked them', t => {
  const directory = fixture(t), file = path.join(directory, 'audit.jsonl');
  fs.writeFileSync(file, JSON.stringify({ time: 'fixture', mechanism: 'fetch', hostname: 'download.deepseek.com', url: 'never-record-this' }) + '\n');
  const audit = readAudit(file);
  assert.equal(audit.attempts, 1);
  assert.equal(JSON.stringify(audit).includes('never-record-this'), false);
  const run = validRun(); run.audit = audit;
  assert.ok(assessRun(run).some(value => value.includes('producer attempted')));
});
test('malformed audit cannot silently count as zero attempts', t => {
  const directory = fixture(t), file = path.join(directory, 'audit.jsonl');
  fs.writeFileSync(file, '{broken'); assert.throws(() => readAudit(file));
  fs.writeFileSync(file, JSON.stringify({ message: 'not a policy record' })); assert.throws(() => readAudit(file));
});
test('DOM records omit arbitrary body content and URL query values', () => {
  const raw = { url: 'dsh-app://app/?token=fixture', rootPresent: true, rootVisible: true, rootInert: false, body: 'private fixture text', buttons: ['Plugins', 'unknown private button'], headings: ['Models'], dialogCount: 0 };
  const summary = summarizeDom(raw, 'main');
  assert.deepEqual(summary.recognizedButtons, ['Plugins']);
  assert.equal(JSON.stringify(summary).includes('private fixture text'), false);
  assert.equal(JSON.stringify(summary).includes('token=fixture'), false);
  assert.equal(summary.bodySha256, hash(raw.body));
});
test('visible DeepSeek credential onboarding and inaccessible navigation fail', () => {
  const run = validRun();
  run.ui.main.forcedLogin = ['Sign in to your DeepSeek account'];
  run.ui.plugins.addControlEnabled = false;
  run.ui.models.accountControlVisible = true;
  assert.equal(assessRun(run).length, 3);
});
test('a normal Settings modal may make the background root inert', () => {
  assert.deepEqual(assessRun(validRun()), []);
  const run = validRun(); run.ui.main.rootInert = true;
  assert.ok(assessRun(run).some(value => value.includes('main: application root is inert')));
});
test('missing readiness, process result, forced exit, and changed artifacts cannot pass', () => {
  for (const mutate of [value => { value.ready = false; }, value => { value.exit = null; }, value => { value.exit.closed = false; }, value => { value.exit.forced = true; }, value => { value.exit.timedOut = true; }, value => { value.artifactUnchanged = false; }]) {
    const run = validRun(); mutate(run); assert.ok(assessRun(run).length > 0);
  }
});
test('rejecting proxy never forwards and fake registry serves no packages', async t => {
  const services = await startOfflineServices(); t.after(() => services.close());
  assert.equal((await request(services.registryUrl, '/-/ping')).status, 200);
  assert.equal((await request(services.registryUrl, '/fixture-package')).status, 404);
  assert.equal((await request(services.proxyUrl, 'http://outside.example.test/path?token=fixture')).status, 502);
  assert.deepEqual(services.records[0], { method: 'GET', hostname: 'outside.example.test', deepseek: false });
  assert.equal(JSON.stringify(services.records).includes('fixture'), false);
  const proxy = new URL(services.proxyUrl);
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(proxy.port) }); let bytes = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('CONNECT fixture timeout')));
    socket.once('connect', () => socket.write('CONNECT outside.example.test:443 HTTP/1.1\r\nHost: outside.example.test:443\r\n\r\n'));
    socket.on('data', chunk => bytes += chunk); socket.once('end', () => { socket.destroy(); resolve(bytes); }); socket.once('error', reject);
  });
  assert.match(response, /502 Bad Gateway/);
  assert.equal(services.records[1].method, 'CONNECT');
  const run = validRun(); run.proxy = { records: services.records };
  assert.ok(assessRun(run).some(value => value.includes('Unexpected proxy egress')));
});
test('child environment excludes credentials and real npm settings', t => {
  const directory = fixture(t);
  const result = isolatedEnvironment(directory, { proxyUrl: 'http://127.0.0.1:1234', registryUrl: 'http://127.0.0.1:1235/' }, {
    SystemRoot: 'C:\\Windows', GH_TOKEN: 'fixture-token', DEEPSEEK_API_KEY: 'fixture-key', NPM_CONFIG_USERCONFIG: 'C:\\private.npmrc', NODE_OPTIONS: '--require something', ELECTRON_RUN_AS_NODE: '1',
  });
  assert.equal(result.env.GH_TOKEN, undefined); assert.equal(result.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(result.env.NODE_OPTIONS, undefined); assert.equal(result.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.ok(result.env.npm_config_userconfig.startsWith(directory + path.sep));
  assert.equal(result.env.NODE_USE_ENV_PROXY, '1'); assert.equal(result.env.IUM_NPM_REGISTRY, 'http://127.0.0.1:1235/');
  for (const file of result.emptyNpmConfigs) assert.equal(fs.readFileSync(file, 'utf8'), '');
});
test('fake Windows KnownFolders exist beneath the isolated USERPROFILE', t => {
  const directory = fixture(t);
  const result = isolatedEnvironment(directory, { proxyUrl: 'http://127.0.0.1:1234', registryUrl: 'http://127.0.0.1:1235/' }, {
    SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\real-profile', APPDATA: 'C:\\real-roaming', LOCALAPPDATA: 'C:\\real-local',
  });
  assert.equal(result.env.USERPROFILE, result.folders.home);
  assert.equal(result.env.APPDATA, path.join(result.env.USERPROFILE, 'AppData', 'Roaming'));
  assert.equal(result.env.LOCALAPPDATA, path.join(result.env.USERPROFILE, 'AppData', 'Local'));
  for (const key of ['appdata', 'localappdata']) {
    assert.equal(result.folders[key], result.env[key === 'appdata' ? 'APPDATA' : 'LOCALAPPDATA']);
    assert.equal(fs.statSync(result.folders[key]).isDirectory(), true);
    assert.ok(fs.realpathSync.native(result.folders[key]).startsWith(fs.realpathSync.native(directory) + path.sep));
  }
  assert.equal(fs.existsSync(path.join(directory, 'appdata')), false);
  assert.equal(fs.existsSync(path.join(directory, 'localappdata')), false);
  assert.notEqual(result.folders['dsh-home'], result.folders.home);
  assert.notEqual(result.folders['user-data'], result.folders.appdata);
});
test('sidebar navigation waits through loading before opening the collapsed sidebar', async () => {
  let probes = 0, visible = false, clicks = 0, visibilityChecks = 0;
  const plugins = {
    async count() { probes++; return probes >= 2 ? 1 : 0; },
    first() { return this; }, async isVisible() { return visible; },
    async waitFor(options) { assert.equal(options.state, 'visible'); assert.equal(visible, true); visibilityChecks++; },
  };
  const sidebar = {
    async count() { return probes >= 2 ? 1 : 0; }, first() { return this; },
    async isVisible() { return probes >= 2; },
    async click() { assert.ok(probes >= 2); clicks++; visible = true; },
  };
  await revealSidebarNavigation(plugins, sidebar, Date.now() + 3000, { closed: false });
  assert.equal(clicks, 1); assert.equal(visibilityChecks, 1);
});
test('already visible Plugins does not toggle the sidebar closed', async () => {
  let clicks = 0, asserted = false;
  const plugins = { async count() { return 1; }, first() { return this; }, async isVisible() { return true; }, async waitFor(options) { assert.equal(options.state, 'visible'); asserted = true; } };
  const sidebar = { async count() { return 1; }, first() { return this; }, async isVisible() { return true; }, async click() { clicks++; } };
  await revealSidebarNavigation(plugins, sidebar, Date.now() + 3000, { closed: false });
  assert.equal(clicks, 0); assert.equal(asserted, true);
});
test('missing navigation still fails rather than skipping readiness assertions', async () => {
  const absent = { async count() { return 0; }, async waitFor() { assert.fail('Navigation never became ready'); } };
  await assert.rejects(revealSidebarNavigation(absent, absent, Date.now() - 1, { closed: false }), /Timed out waiting/);
});
test('enabled control readiness waits through initial inventory loading', async () => {
  let probes = 0;
  const control = { async count() { return 1; }, first() { return this; }, async isVisible() { return true; }, async isEnabled() { return ++probes >= 2; } };
  await waitForEnabledControl(control, 'enabled fixture control', Date.now() + 3000, { closed: false });
  assert.equal(probes, 2);
});
test('persistently disabled control and exited process remain readiness failures', async () => {
  const disabled = { async count() { return 1; }, first() { return this; }, async isVisible() { return true; }, async isEnabled() { return false; } };
  await assert.rejects(waitForEnabledControl(disabled, 'disabled fixture', Date.now() - 1, { closed: false }), /Timed out waiting/);
  await assert.rejects(waitForEnabledControl(disabled, 'disabled fixture', Date.now() + 1000, { closed: true }), /Desktop exited/);
});
test('artifact manifest identity/version is verified without executing a binary', t => {
  const directory = fixture(t), archive = path.join(directory, 'app.asar');
  const expected = { identity: { packageName: '@lizy14/dsh-desktop-ium', appId: 'io.github.lizy14.dshium' } };
  const body = Buffer.from(JSON.stringify({ name: expected.identity.packageName, main: 'lib/ium-bootstrap.js', dshDesktopAppId: expected.identity.appId, version: 'fixture-version' }));
  const tree = { files: { 'package.json': { offset: '0', size: body.length, integrity: { algorithm: 'SHA256', hash: hash(body) } } } };
  const header = Buffer.from(JSON.stringify(tree)), prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(8 + header.length, 4); prefix.writeUInt32LE(4 + header.length, 8); prefix.writeUInt32LE(header.length, 12);
  fs.writeFileSync(archive, Buffer.concat([prefix, header, body]));
  const identity = readArtifactIdentity(archive);
  validateIdentity(identity, expected, 'fixture-version');
  assert.throws(() => validateIdentity(identity, expected, 'wrong-version'));
  assert.throws(() => validateIdentity({ ...identity, name: 'original-application' }, expected, 'fixture-version'));
});
test('missing artifact writes a fresh FAIL and never starts a Desktop', async t => {
  const directory = fixture(t), rootDirectory = path.join(directory, 'recipe');
  fs.mkdirSync(path.join(rootDirectory, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(rootDirectory, 'profiles/work.json'), JSON.stringify({ identity: { productName: 'DSH Ium' } }));
  const result = await runGuiSmoke({ rootDirectory, workDirectory: path.join(directory, 'work'), upstreamDirectory: path.join(directory, 'upstream'), artifactDirectory: path.join(directory, 'missing-artifact'), expectedVersion: 'fixture-version', timeoutMs: 10000 });
  assert.equal(result.result, 'FAIL'); assert.equal(result.ownedProcess, null); assert.equal(result.ready, false);
  assert.equal(result.minimumGuiAcceptancePassed, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory, 'gui-smoke-result.json'), 'utf8')).result, 'FAIL');
});
