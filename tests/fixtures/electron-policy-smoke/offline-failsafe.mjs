/** Independent test-only fail-safe: no external DNS or sockets, even if Ium is broken. */
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

export const OFFLINE_ERROR_CODE = 'ERR_TEST_EXTERNAL_NETWORK_FORBIDDEN';
export function installOfflineFailsafe() {
  const restores = [];
  const stats = { denied: 0, allowedLoopbackConnects: 0, realDnsQueries: 0, externalConnections: 0 };
  const deny = () => { stats.denied++; return Object.assign(new Error('Offline test prevented external networking'), { code: OFFLINE_ERROR_CODE }); };
  const local = host => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(String(host ?? 'localhost').toLowerCase());
  const socketHost = args => {
    if (Array.isArray(args[0])) return socketHost(args[0]);
    if (args[0] && typeof args[0] === 'object') {
      if (typeof args[0].path === 'string' && args[0].path.length > 0) return '[IPC disallowed by this test]';
      return args[0].host ?? 'localhost';
    }
    if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) return '[IPC disallowed by this test]';
    return typeof args[1] === 'string' ? args[1] : 'localhost';
  };
  const replace = (object, key, factory) => {
    if (typeof object[key] !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const old = object[key]; const replacement = factory(old);
    if (!Reflect.set(object, key, replacement)) throw new Error('Cannot install offline fail-safe: ' + key);
    restores.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key]; });
  };
  for (const [object, key] of [[net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect']]) replace(object, key, original => function (...args) {
    if (!local(socketHost(args))) throw deny();
    stats.allowedLoopbackConnects++;
    return Reflect.apply(original, this, args);
  });
  // This fixture deliberately tests HTTP loopback only; TLS must never connect.
  replace(tls, 'connect', () => function () { throw deny(); });
  const localAnswer = (host, options) => {
    const family = host === '::1' || host === '[::1]' || options?.family === 6 || options === 6 ? 6 : 4;
    const entry = { address: family === 6 ? '::1' : '127.0.0.1', family };
    return options?.all ? [entry] : entry;
  };
  replace(dns, 'lookup', () => function (host, ...rest) {
    const callback = rest.at(-1);
    if (typeof callback !== 'function') throw new TypeError('lookup callback required by offline fixture');
    if (!local(host)) { const error = deny(); queueMicrotask(() => callback(error)); return; }
    const answer = localAnswer(host, rest[0]);
    queueMicrotask(() => Array.isArray(answer) ? callback(null, answer) : callback(null, answer.address, answer.family));
  });
  replace(dns.promises, 'lookup', () => async function (host, options) {
    if (!local(host)) throw deny();
    return localAnswer(host, options);
  });
  const queries = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'];
  for (const key of queries) {
    for (const object of [dns, dns.Resolver.prototype]) replace(object, key, () => function (...args) {
      const error = deny(); const callback = args.at(-1);
      if (typeof callback !== 'function') throw error;
      queueMicrotask(() => callback(error));
    });
    for (const object of [dns.promises, dns.promises.Resolver.prototype]) replace(object, key, () => async function () { throw deny(); });
  }
  replace(globalThis, 'fetch', original => function (input, init) {
    let host;
    try { host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname; } catch { return Promise.reject(deny()); }
    if (!local(host)) return Promise.reject(deny());
    return Reflect.apply(original, this, [input, init]);
  });
  syncBuiltinESMExports();
  return { stats, restore() { for (const restore of restores.splice(0).reverse()) restore(); syncBuiltinESMExports(); } };
}
