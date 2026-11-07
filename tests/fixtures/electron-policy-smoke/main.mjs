/** Native component smoke for CI. Never launch this through the original installed Desktop. */
import { app, session, net as electronNet, shell } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { installOfflineFailsafe } from './offline-failsafe.mjs';

const outputDirectory = process.env.IUM_POLICY_SMOKE_DIR;
if (!outputDirectory || !path.isAbsolute(outputDirectory)) throw new Error('IUM_POLICY_SMOKE_DIR must be an absolute isolated CI artifact directory');
fs.mkdirSync(outputDirectory, { recursive: true });
const checkpoint = phase => fs.writeFileSync(path.join(outputDirectory, 'startup-phase.json'), JSON.stringify({ phase, pid: process.pid, electron: process.versions.electron, node: process.versions.node }));
checkpoint('entry-loaded');
const userDataDirectory = path.join(outputDirectory, 'user-data');
fs.mkdirSync(userDataDirectory, { recursive: true });
app.setPath('userData', userDataDirectory);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
// Independent Chromium fail-safe. It remains in force even if policy installation
// fails. HTTP(S) tests also use a fixed local rejecting proxy; no external DNS.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
// Initialize Node's native fetch/ambient proxy dispatcher through a data URL
// before importing the external Undici-backed policy. This performs no I/O.
const initializedFetch = await globalThis.fetch('data:,ium-policy-initialize');
await initializedFetch.body?.cancel();
const failsafe = installOfflineFailsafe();
const nativeRequest = electronNet.request.bind(electronNet);
const moduleUrl = process.env.IUM_POLICY_MODULE ? new URL(process.env.IUM_POLICY_MODULE) : new URL('../../../overlays/desktop/ium-network-policy.mjs', import.meta.url);
if (moduleUrl.protocol !== 'file:') throw new Error('IUM_POLICY_MODULE must be a local file URL');
const output = path.join(outputDirectory, 'network-policy-native-smoke.json');
if (fs.existsSync(output)) throw new Error('Use a fresh native-smoke directory; refusing a stale result file');
const events = [];
let forbiddenProxyAttempts = 0;
let server;
let completed = false;
const finish = (code, result) => {
  if (completed) return;
  completed = true;
  let sourcePolicySha256 = null;
  try { sourcePolicySha256 = createHash('sha256').update(fs.readFileSync(fileURLToPath(moduleUrl))).digest('hex'); } catch { /* Missing overlay is already a failed smoke, never a fallback launch. */ }
  try {
    fs.writeFileSync(output, JSON.stringify({
      ...result, electron: process.versions.electron, node: process.versions.node,
      sourcePolicySha256,
      nativeComponentSmokeOnly: true, packagedDesktopAcceptance: false,
      forbiddenProxyAttempts, independentNodeFailsafe: failsafe.stats, events,
    }, null, 2));
  } finally {
    server?.closeAllConnections(); server?.close();
    // Deliberately do not remove guards while Chromium is shutting down.
    app.exit(code);
  }
};
const deadline = setTimeout(() => finish(1, { result: 'FAIL', reason: 'native fixture deadline exceeded' }), 20000);

async function run() {
  await app.whenReady();
  checkpoint('electron-ready');
  const { createPolicyOwner, installNodePolicy, installElectronPolicy } = await import(moduleUrl.href);
  const owner = createPolicyOwner({ audit: event => events.push(event) });
  installNodePolicy(owner);
  installElectronPolicy({ app, session, net: electronNet, shell }, owner);
  server = http.createServer((request, response) => {
    if (/^https?:\/\//i.test(request.url)) { forbiddenProxyAttempts++; response.writeHead(403); response.end(); return; }
    if (request.url === '/to-blocked') { response.writeHead(302, { Location: 'https://api.deepseek.com/never-contacted' }); response.end(); return; }
    if (request.url === '/to-local') { response.writeHead(302, { Location: '/ok' }); response.end(); return; }
    response.end('loopback-native-ok');
  });
  server.on('connect', (_request, socket) => { forbiddenProxyAttempts++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const proxyConfig = { mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`, proxyBypassRules: '127.0.0.1;localhost' };
  await session.defaultSession.setProxy(proxyConfig);
  const request = (url, browserSession = session.defaultSession) => new Promise((resolve, reject) => {
    const req = nativeRequest({ url, session: browserSession, redirect: 'follow' });
    const timer = setTimeout(() => { req.abort(); reject(new Error('native local request timeout')); }, 3000);
    req.once('response', response => {
      let body = ''; response.on('data', chunk => body += chunk.toString());
      response.once('end', () => { clearTimeout(timer); resolve(body); });
    });
    req.once('error', error => { clearTimeout(timer); reject(error); });
    req.end();
  });
  assert.equal(await (await electronNet.fetch(origin + '/to-local')).text(), 'loopback-native-ok');
  assert.equal(await request(origin + '/to-local'), 'loopback-native-ok');
  let originalListenerCalls = 0;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://127.0.0.1/*'] }, (_details, callback) => { originalListenerCalls++; callback({}); });
  // The retained original request entry reaches Chromium without the outer JS URL guard.
  for (const url of ['https://deepseek.com/', 'https://api.deepseek.com/', 'https://api.deepseek.com./', 'https://dsh-otel-collector.deepseeksvc.com/']) await assert.rejects(request(url), /ERR_BLOCKED_BY_CLIENT/);
  assert.equal(originalListenerCalls, 0);
  await assert.rejects(request(origin + '/to-blocked'), /ERR_BLOCKED_BY_CLIENT/);
  assert.equal(originalListenerCalls, 1);
  assert.ok(events.some(e => e.mechanism === 'electron.webRequest' && e.hostname === 'api.deepseek.com'));
  session.defaultSession.webRequest.onBeforeRequest(null);
  await assert.rejects(request('https://download.deepseek.com/'), /ERR_BLOCKED_BY_CLIENT/);
  const guest = session.fromPartition('ium-policy-isolated-native-guest');
  await guest.setProxy(proxyConfig);
  guest.webRequest.onBeforeRequest((_details, callback) => callback({}));
  assert.equal(await request(origin + '/ok', guest), 'loopback-native-ok');
  await assert.rejects(request('https://platform.deepseek.com/', guest), /ERR_BLOCKED_BY_CLIENT/);
  assert.equal(forbiddenProxyAttempts, 0, 'policy failures must be caught by the loopback proxy, never sent externally');
  assert.equal(failsafe.stats.denied, 0, 'Node policy must stop blocked paths before the separate fail-safe');
  assert.ok(events.filter(e => e.mechanism === 'electron.webRequest').length >= 5);
  clearTimeout(deadline);
  finish(0, { result: 'PASS', nativeFilterUnion: true, nativeNullCleanup: true, nativeAllowedRedirect: true, nativeBlockedRedirect: true });
}
run().catch(error => { clearTimeout(deadline); finish(1, { result: 'FAIL', reason: String(error.message) }); });
