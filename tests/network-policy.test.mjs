import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https, { request as earlyHttpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { Dispatcher, Pool, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createPolicyOwner, installNodePolicy, installElectronPolicy, blockedHost, blockedUrl, normalizeHostname, BLOCKED_ERROR_CODE } from '../overlays/desktop/ium-network-policy.mjs';
import { installOfflineFailsafe, OFFLINE_ERROR_CODE } from './fixtures/electron-policy-smoke/offline-failsafe.mjs';

const require = createRequire(import.meta.url);
const undiciVersion = require('undici/package.json').version;

// A real loopback forward proxy. The safety allowlist is intentionally unrelated
// to the Ium domain classifier: it can forward only to this one local fixture.
async function createForwardProxy(allowedOrigin) {
  const allowed = new URL(allowedOrigin);
  const seen = [];
  let forbidden = 0;
  let connections = 0;
  const proxy = http.createServer((request, response) => {
    let target;
    try { target = new URL(request.url); } catch { forbidden++; response.writeHead(400); response.end(); return; }
    seen.push(target.href);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.port !== allowed.port) {
      forbidden++; response.writeHead(403); response.end(); return;
    }
    const upstream = http.request(target, { method: request.method, headers: { ...request.headers, host: target.host } }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.once('error', () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  // These cases use proxyTunnel:false. An unexpected CONNECT never leaves the
  // loopback server and makes the test fail instead of resolving its authority.
  proxy.on('connect', (_request, socket) => { forbidden++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  proxy.on('connection', () => connections++);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${proxy.address().port}`, seen,
    get forbidden() { return forbidden; }, get connections() { return connections; },
    async close() { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); },
  };
}
class ForwardingCustomDispatcher extends Dispatcher {
  constructor(proxyOrigin) { super(); this.pool = new Pool(proxyOrigin, { connections: 1 }); this.proxyOrigin = proxyOrigin; this.seenOrigins = []; }
  dispatch(options, handler) {
    this.seenOrigins.push(String(options.origin));
    const destination = new URL(options.path, options.origin);
    return this.pool.dispatch({ ...options, origin: this.proxyOrigin, path: destination.href }, handler);
  }
  close(...args) { return this.pool.close(...args); }
  destroy(...args) { return this.pool.destroy(...args); }
}

const hasCode = code => error => {
  for (let current = error, depth = 0; current && depth < 10; current = current.cause, depth++) if (current.code === code) return true;
  return false;
};
const blocked = hasCode(BLOCKED_ERROR_CODE);
const callbackResult = call => new Promise((resolve, reject) => call((error, ...values) => error ? reject(error) : resolve(values)));
const readHttp = (input, options) => new Promise((resolve, reject) => {
  const receive = response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
    response.once('end', () => resolve({ status: response.statusCode, body }));
  };
  const request = options === undefined ? http.get(input, receive) : http.get(input, options, receive);
  request.setTimeout(3000, () => request.destroy(new Error('Offline HTTP fixture timeout')));
  request.once('error', reject);
});

// A small mock of the documented Chrome match-pattern subset used by this test.
// This is not the policy's implementation; it ensures union tests don't merely
// invoke listeners that native Chromium would not have selected.
function matches(pattern, value) {
  const url = new URL(value);
  if (pattern === '<all_urls>') return ['http:', 'https:', 'ws:', 'wss:', 'file:', 'ftp:'].includes(url.protocol);
  const parsed = /^(\*|[a-z]+):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!parsed) throw new Error('Unsupported mock pattern: ' + pattern);
  const [, scheme, authority, pathname] = parsed;
  if (scheme === '*' ? !['http:', 'https:'].includes(url.protocol) : url.protocol !== scheme + ':') return false;
  const host = url.hostname.toLowerCase(); const expected = authority.toLowerCase();
  if (expected !== '*' && !(expected.startsWith('*.') ? host === expected.slice(2) || host.endsWith(expected.slice(1)) : host === expected)) return false;
  const escaped = pathname.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + escaped + '$').test(url.pathname + url.search);
}
function mockSession() {
  const calls = [];
  const webRequest = {
    registration: null,
    onBeforeRequest(first, second) {
      this.registration = first === null ? null : typeof first === 'function' ? { filter: null, listener: first } : { filter: first, listener: second };
    },
    invoke(url) {
      const current = this.registration;
      if (!current || current.filter && !current.filter.urls.some(pattern => matches(pattern, url))) return { selected: false };
      let answer; current.listener.call(this, { url }, result => { answer = result; });
      return { selected: true, answer };
    },
  };
  return { webRequest, calls, fetch(input, init) { calls.push({ receiver: this, input, init }); return Promise.resolve('session-allowed'); } };
}

// One serial root owns process-wide methods. Its fail-safe is installed BEFORE
// any test involving external hostnames and stays until all clients are stopped.
test('Ium application network policy (offline, explicit process owner)', { concurrency: false, timeout: 15000 }, async t => {
  const failsafe = installOfflineFailsafe();
  const originalGlobalDispatcher = getGlobalDispatcher();
  const events = [];
  const owner = createPolicyOwner({ audit: event => events.push(event) });
  let server;
  let electronOwner;
  try {
    installNodePolicy(owner);
    await t.test('canonical hostnames and boundaries, not arbitrary substrings', () => {
      for (const host of ['deepseek.com', 'API.DeepSeek.COM.', 'api.deepseek.com...', 'deepseeksvc.com:443', 'dsh-otel-collector.deepseeksvc.com', 'ｄｅｅｐｓｅｅｋ.com', 'api.deepseek。com']) assert.ok(blockedHost(host), host);
      for (const host of ['github.com', 'api.githubcopilot.com', 'api.individual.githubcopilot.com', '127.0.0.1', '::1', '[::1]:80', 'notdeepseek.com', 'deepseek.com.evil.example', 'deepseeksvc.com.example']) assert.equal(blockedHost(host), null, host);
      assert.equal(normalizeHostname('API.DEEPSEEK.COM.:443'), 'api.deepseek.com');
      assert.equal(blockedUrl('https://user:DO-NOT-LOG@api.deepseek.com/path?token=DO-NOT-LOG'), 'api.deepseek.com');
      assert.equal(blockedUrl('https://github.com/deepseek-ai/deepseek-harness'), null);
      assert.equal(blockedUrl('/deepseek.com'), null);
    });
    await t.test('explicit ownership and same-owner installation is idempotent', () => {
      assert.equal(undiciVersion, '7.29.1');
      assert.notEqual(getGlobalDispatcher(), originalGlobalDispatcher);
      assert.throws(() => installNodePolicy(), /live createPolicyOwner/);
      const request = http.request; const fetch = globalThis.fetch;
      assert.equal(installNodePolicy(owner), owner);
      assert.equal(http.request, request); assert.equal(globalThis.fetch, fetch);
      const dispatcher = getGlobalDispatcher();
      let observed = 0;
      const listener = value => { observed = value; };
      assert.equal(dispatcher.on('ium-policy-test-event', listener), dispatcher);
      originalGlobalDispatcher.emit('ium-policy-test-event', 7);
      assert.equal(observed, 7);
      assert.equal(dispatcher.listenerCount('ium-policy-test-event'), 1);
      dispatcher.off('ium-policy-test-event', listener);
      assert.equal(originalGlobalDispatcher.listenerCount('ium-policy-test-event'), 0);
    });
    await t.test('http(s) methods, effective authority, absolute proxy path and Host headers', () => {
      for (const call of [
        () => http.get('http://api.deepseek.com/'),
        () => http.request(new URL('http://deepseeksvc.com/')),
        () => https.get('https://download.deepseek.com/'),
        () => https.request({ host: 'api.deepseek.com', path: '/' }),
        () => http.request('http://127.0.0.1/', { hostname: 'api.deepseek.com' }),
        () => http.request('http://127.0.0.1/', { hostname: undefined, host: 'api.deepseek.com' }),
        () => http.request({ host: '127.0.0.1', path: 'https://api.deepseek.com/secret?token=DO-NOT-LOG' }),
        () => http.request({ host: '127.0.0.1', headers: { HOST: 'API.DEEPSEEK.COM.:443' } }),
        () => http.request({ host: '127.0.0.1', headers: { Host: 'DO-NOT-LOG@api.deepseek.com' } }),
        () => http.request({ host: '127.0.0.1', headers: ['hOsT', 'api.deepseek.com'] }),
        () => http.request({ host: '127.0.0.1', headers: { ':authority': 'deepseeksvc.com' } }),
      ]) assert.throws(call, blocked);
      // A URL's hostname remains authoritative when only options.host is supplied.
      assert.throws(() => http.request('http://api.deepseek.com/', { host: '127.0.0.1' }), blocked);
      // ESM named binding imported before installation follows syncBuiltinESMExports.
      assert.throws(() => earlyHttpsRequest('https://api.deepseek.com/'), blocked);
    });
    await t.test('net normalized arrays, positional signatures and TLS SNI', () => {
      for (const call of [
        () => net.connect(443, 'api.deepseek.com'),
        () => net.createConnection({ port: 443, host: 'api.deepseek.com.' }),
        () => net.connect({ port: 443, host: 'api.deepseek.com', path: null }),
        () => new net.Socket().connect([{ port: 443, host: 'api.deepseek.com' }, () => {}]),
        () => tls.connect({ host: '127.0.0.1', servername: 'api.deepseek.com', port: 443 }),
        () => tls.connect(443, '127.0.0.1', { servername: 'api.deepseek.com' }),
        () => tls.connect({ host: 'api.deepseek.com', rejectUnauthorized: true }),
      ]) assert.throws(call, blocked);
    });
    await t.test('DNS lookup, resolver and promise APIs reject before the independent fail-safe', async () => {
      await assert.rejects(callbackResult(cb => dns.lookup('api.deepseek.com', { all: true }, cb)), blocked);
      await assert.rejects(callbackResult(cb => dns.resolve('api.deepseek.com', 'A', cb)), blocked);
      await assert.rejects(callbackResult(cb => new dns.Resolver().resolve4('api.deepseek.com', cb)), blocked);
      await assert.rejects(dns.promises.lookup('deepseeksvc.com'), blocked);
      await assert.rejects(dns.promises.resolve6('api.deepseek.com'), blocked);
      await assert.rejects(new dns.promises.Resolver().resolveTxt('api.deepseek.com'), blocked);
      assert.deepEqual(await dns.promises.lookup('localhost', { all: true }), [{ address: '127.0.0.1', family: 4 }]);
    });
    await t.test('fetch strings, URL, Request and authority-header overrides', async () => {
      for (const input of ['https://api.deepseek.com/', new URL('https://deepseeksvc.com/'), new Request('https://download.deepseek.com/')]) await assert.rejects(fetch(input), blocked);
      await assert.rejects(fetch('http://127.0.0.1/', { headers: { Host: 'api.deepseek.com' } }), blocked);
      await assert.rejects(fetch(new Request('http://127.0.0.1/', { headers: { Host: 'api.deepseek.com' } })), blocked);
    });

    server = http.createServer((request, response) => {
      if (request.url === '/to-blocked') { response.writeHead(302, { Location: 'https://api.deepseek.com/not-contacted?token=DO-NOT-LOG' }); response.end(); }
      else if (request.url === '/to-blocked-http') { response.writeHead(302, { Location: 'http://api.deepseek.com/not-contacted?token=DO-NOT-LOG' }); response.end(); }
      else if (request.url === '/to-local') { response.writeHead(302, { Location: '/ok' }); response.end(); }
      else if (request.url === '/preserve-post') { response.writeHead(307, { Location: '/echo' }); response.end(); }
      else if (request.url === '/echo') { let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => response.end(request.method + ':' + body)); }
      else response.end('loopback-allowed');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    await t.test('real loopback HTTP and URL options use the effective target, not a stale URL', async () => {
      assert.equal((await readHttp(origin + '/ok')).body, 'loopback-allowed');
      assert.equal((await readHttp('http://api.deepseek.com/ok', { hostname: '127.0.0.1', port })).body, 'loopback-allowed');
      assert.equal((await readHttp('http://api.deepseek.com/ok', { hostname: undefined, host: '127.0.0.1', port })).body, 'loopback-allowed');
      assert.equal((await readHttp(origin + '/ok', { host: 'api.deepseek.com' })).body, 'loopback-allowed');
      assert.equal((await readHttp({ host: 'api.deepseek.com', hostname: '127.0.0.1', port, path: '/ok' })).body, 'loopback-allowed');
    });
    await t.test('native fetch keeps allowed redirect semantics and blocks new prohibited connections', async () => {
      assert.equal(await (await fetch(origin + '/to-local')).text(), 'loopback-allowed');
      assert.equal(await (await fetch(origin + '/preserve-post', { method: 'POST', body: 'payload' })).text(), 'POST:payload');
      const manual = await fetch(origin + '/to-local', { redirect: 'manual' });
      assert.equal(manual.status, 302); await manual.body?.cancel();
      const before = events.length;
      await assert.rejects(fetch(origin + '/to-blocked'), blocked);
      assert.ok(events.slice(before).some(e => e.mechanism === 'undici.dispatch' && e.hostname === 'api.deepseek.com'));
    });
    await t.test('global HTTP proxy reuses its connection but never receives a forbidden redirect target', async () => {
      const proxy = await createForwardProxy(origin);
      const dispatcher = new ProxyAgent({
        uri: proxy.origin, proxyTunnel: false,
        // Http1ProxyWrapper passes only connect to its factory, so explicitly
        // retain the one-connection limit instead of relying on outer options.
        factory: (address, options) => new Pool(address, { ...options, connections: 1 }),
      });
      const previous = getGlobalDispatcher();
      try {
        // A legitimate proxy can be selected after installation. The public
        // global fetch wrapper must still attach per-dispatch enforcement.
        setGlobalDispatcher(dispatcher);
        assert.equal(await (await fetch(origin + '/ok')).text(), 'loopback-allowed');
        const before = events.length;
        await assert.rejects(fetch(origin + '/to-blocked-http'), blocked);
        assert.deepEqual(proxy.seen, [origin + '/ok', origin + '/to-blocked-http']);
        assert.equal(proxy.forbidden, 0);
        assert.equal(proxy.connections, 1, 'the allowed hops reused a real proxy connection');
        assert.ok(events.slice(before).some(e => e.mechanism === 'undici.dispatch'));
      } finally { setGlobalDispatcher(previous); await dispatcher.close(); await proxy.close(); }
    });
    await t.test('explicit custom dispatcher redirects are checked before proxy origin rewriting', async () => {
      const proxy = await createForwardProxy(origin);
      const dispatcher = new ForwardingCustomDispatcher(proxy.origin);
      const inheritedInit = Object.create({ redirect: 'follow' });
      Object.defineProperty(inheritedInit, 'dispatcher', { value: dispatcher, enumerable: false });
      const options = Object.freeze(inheritedInit);
      try {
        assert.equal(await (await fetch(origin + '/ok', options)).text(), 'loopback-allowed');
        await assert.rejects(fetch(origin + '/to-blocked-http', options), blocked);
        assert.deepEqual(dispatcher.seenOrigins, [origin, origin]);
        assert.deepEqual(proxy.seen, [origin + '/ok', origin + '/to-blocked-http']);
        assert.equal(proxy.forbidden, 0);
        assert.equal(proxy.connections, 1);
        assert.equal(options.dispatcher, dispatcher, 'caller dispatcher is never mutated');
        assert.equal(Object.hasOwn(options, 'redirect'), false, 'inherited RequestInit fields preserved');
      } finally { await dispatcher.close(); await proxy.close(); }
    });
    await t.test('global dispatcher rejects prohibited origin, proxy absolute path, CONNECT and Host before delegating', () => {
      const guarded = getGlobalDispatcher();
      for (const options of [
        { origin: 'https://api.deepseek.com', path: '/', method: 'GET' },
        { origin, path: 'http://api.deepseek.com/proxy-target', method: 'GET' },
        { origin, path: 'api.deepseek.com:443', method: 'CONNECT' },
        { origin, path: '/', method: 'GET', headers: ['host', 'api.deepseek.com'] },
        { origin, path: '/', method: 'GET', headers: { ':authority': 'api.deepseek.com' } },
      ]) assert.throws(() => guarded.dispatch(options, {}), blocked);
    });

    await t.test('Electron registrations compose filters and cannot remove deny rules with null', async () => {
      const app = new EventEmitter(); app.isReady = () => true;
      const browserSession = mockSession();
      const netCalls = []; const shellCalls = [];
      const electronNet = { request(...args) { netCalls.push({ receiver: this, args }); return 'request-allowed'; }, fetch(...args) { netCalls.push({ receiver: this, args }); return Promise.resolve('fetch-allowed'); } };
      const shell = { openExternal(...args) { shellCalls.push({ receiver: this, args }); return Promise.resolve('open-allowed'); } };
      electronOwner = createPolicyOwner({ audit: event => events.push(event) });
      installElectronPolicy({ app, session: { defaultSession: browserSession }, net: electronNet, shell }, electronOwner);
      const registration = browserSession.webRequest.onBeforeRequest;
      installElectronPolicy({ app, session: { defaultSession: browserSession }, net: electronNet, shell }, electronOwner);
      assert.equal(browserSession.webRequest.onBeforeRequest, registration);
      for (const url of ['https://deepseek.com/', 'https://api.deepseek.com/', 'http://api.deepseek.com./', 'wss://api.deepseek.com/socket', 'ws://deepseeksvc.com/socket']) assert.deepEqual(browserSession.webRequest.invoke(url), { selected: true, answer: { cancel: true } }, url);
      assert.equal(browserSession.webRequest.invoke('https://github.com/').selected, false);
      let listenerCalls = 0;
      const filter = { urls: ['https://github.com/*'] };
      browserSession.webRequest.onBeforeRequest(filter, function (_details, callback) { assert.equal(this, browserSession.webRequest); listenerCalls++; callback({ cancel: false }); });
      assert.deepEqual(filter, { urls: ['https://github.com/*'] }, 'caller filter not mutated');
      assert.equal(browserSession.webRequest.invoke('https://unrelated.example/').selected, false);
      assert.equal(browserSession.webRequest.invoke('https://api.deepseek.com/').answer.cancel, true);
      assert.equal(listenerCalls, 0);
      assert.equal(browserSession.webRequest.invoke('https://github.com/').answer.cancel, false);
      assert.equal(listenerCalls, 1);
      browserSession.webRequest.onBeforeRequest(filter, null);
      assert.equal(browserSession.webRequest.invoke('https://api.deepseek.com/').answer.cancel, true);
      assert.equal(browserSession.webRequest.invoke('https://github.com/').selected, false);
      browserSession.webRequest.onBeforeRequest(null);
      assert.equal(browserSession.webRequest.invoke('https://deepseeksvc.com/').answer.cancel, true);
      assert.throws(() => browserSession.webRequest.onBeforeRequest({}, () => {}), /filter.urls/);
      const guest = mockSession(); app.emit('session-created', guest);
      guest.webRequest.onBeforeRequest((_details, cb) => cb({ cancel: false }));
      assert.equal(guest.webRequest.invoke('https://github.com/').answer.cancel, false);
      assert.equal(guest.webRequest.invoke('https://api.deepseek.com/').answer.cancel, true);
      await assert.rejects(guest.fetch('https://api.deepseek.com/'), blocked);
      assert.equal(await guest.fetch('https://api.githubcopilot.com/'), 'session-allowed');
      assert.equal(guest.calls[0].receiver, guest);
      assert.throws(() => electronNet.request({ url: 'https://download.deepseek.com/' }), blocked);
      await assert.rejects(electronNet.fetch('https://api.deepseek.com/'), blocked);
      assert.equal(await electronNet.fetch('https://api.githubcopilot.com/'), 'fetch-allowed');
      assert.equal(netCalls[0].receiver, electronNet);
      await assert.rejects(shell.openExternal('https://platform.deepseek.com/'), blocked);
      assert.equal(await shell.openExternal('https://github.com/'), 'open-allowed');
      assert.equal(shellCalls[0].receiver, shell);
      const contents = new EventEmitter(); contents.loadURL = () => Promise.resolve('navigation-allowed');
      app.emit('web-contents-created', {}, contents);
      let prevented = false; contents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://api.deepseek.com/'); assert.equal(prevented, true);
      prevented = false; contents.emit('will-redirect', { url: 'https://api.deepseek.com/', preventDefault() { prevented = true; } }); assert.equal(prevented, true);
      await assert.rejects(contents.loadURL('https://api.deepseek.com/'), blocked);
      assert.equal(await contents.loadURL('http://127.0.0.1/'), 'navigation-allowed');
      electronOwner.dispose(); electronOwner = undefined;
      assert.equal(app.listenerCount('session-created'), 0);
      assert.equal(browserSession.webRequest.registration, null);
      assert.equal(guest.webRequest.invoke('https://github.com/').answer.cancel, false, 'dispose restores last caller listener');
    });
    await t.test('Electron setup before ready and logger failures stay fail-closed', async () => {
      const app = new EventEmitter(); app.isReady = () => false;
      const s = mockSession(); const testOwner = createPolicyOwner({ audit() { throw new Error('logging unavailable'); } });
      try {
        installElectronPolicy({ app, session: { defaultSession: s } }, testOwner);
        assert.equal(s.webRequest.registration, null);
        app.emit('ready');
        assert.equal(s.webRequest.invoke('https://api.deepseek.com/').answer.cancel, true);
      } finally { testOwner.dispose(); }
    });
    await t.test('audit records contain only mechanism/hostname and no URL/credential data', () => {
      assert.ok(events.length > 10);
      for (const event of events) {
        assert.deepEqual(Object.keys(event).sort(), ['hostname', 'mechanism']);
        assert.ok(!JSON.stringify(event).includes('DO-NOT-LOG'));
        assert.ok(!JSON.stringify(event).includes('?'));
        assert.ok(!JSON.stringify(event).includes('https://'));
      }
      assert.equal(failsafe.stats.denied, 0, 'all prohibited policy tests stopped before the separate fail-safe');
      assert.equal(failsafe.stats.realDnsQueries, 0);
      assert.equal(failsafe.stats.externalConnections, 0);
      assert.ok(failsafe.stats.allowedLoopbackConnects > 0);
    });
    // Prove the independent safety layer still rejects external traffic when
    // the policy is absent; these primitives never invoke the original network.
    owner.dispose();
    assert.equal(getGlobalDispatcher(), originalGlobalDispatcher, 'dispose restores the exact original global dispatcher without closing it');
    await t.test('independent fail-safe remains effective without the Ium policy', async () => {
      await assert.rejects(fetch('https://api.deepseek.com/'), hasCode(OFFLINE_ERROR_CODE));
      await assert.rejects(dns.promises.lookup('api.deepseek.com'), hasCode(OFFLINE_ERROR_CODE));
      assert.throws(() => net.connect(443, '203.0.113.1'), hasCode(OFFLINE_ERROR_CODE));
      assert.throws(() => tls.connect({ host: 'api.deepseek.com', port: 443 }), hasCode(OFFLINE_ERROR_CODE));
      assert.equal(failsafe.stats.realDnsQueries, 0);
      assert.equal(failsafe.stats.externalConnections, 0);
    });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    electronOwner?.dispose(); owner.dispose(); failsafe.restore();
  }
});
