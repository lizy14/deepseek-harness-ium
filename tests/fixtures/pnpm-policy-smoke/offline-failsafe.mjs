/** Independent inner test guard. No external DNS, socket, TLS, worker or subprocess may escape. */
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const resultFile = process.env.IUM_PNPM_SMOKE_RESULT;
const registry = new URL(process.env.IUM_PNPM_SMOKE_REGISTRY);
if (!resultFile || registry.hostname !== '127.0.0.1' || registry.protocol !== 'http:' || !registry.port) throw new Error('Offline PNPM smoke requires an isolated result file and loopback registry');
const stats = { denied: 0, allowedLoopbackConnects: 0, allowedDataFetches: 0, syntheticLookups: 0, realDnsQueries: 0, externalConnections: 0, deniedConfigReads: 0, configReads: [], workersStarted: 0, workerIds: [], deniedMechanisms: [] };
const fail = mechanism => {
  stats.denied++;
  stats.deniedMechanisms.push(mechanism);
  return Object.assign(new Error(`Independent offline failsafe denied ${mechanism}`), { code: 'ERR_PNPM_SMOKE_EXTERNAL_NETWORK' });
};
const local = host => ['127.0.0.1', 'localhost'].includes(String(host ?? 'localhost').toLowerCase());
const optionsOf = args => {
  if (Array.isArray(args[0])) return optionsOf(args[0]);
  if (args[0] && typeof args[0] === 'object') return args[0];
  if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) return { path: args[0] };
  return { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
};
function wrap(target, name, replacement) {
  if (typeof target[name] !== 'function') return;
  const original = target[name];
  target[name] = replacement(original);
}
for (const [target, name] of [[net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect']]) wrap(target, name, original => function (...args) {
  const options = optionsOf(args);
  if (options.path || !local(options.host ?? options.hostname) || Number(options.port) !== Number(registry.port)) throw fail(`socket.${name}`);
  stats.allowedLoopbackConnects++;
  return Reflect.apply(original, this, args);
});
wrap(tls, 'connect', () => function () { throw fail('tls.connect'); });
wrap(dns, 'lookup', () => function (host, ...rest) {
  const callback = rest.at(-1);
  if (typeof callback !== 'function') throw new TypeError('Offline lookup callback required');
  if (!local(host)) { const error = fail('dns.lookup'); queueMicrotask(() => callback(error)); return; }
  stats.syntheticLookups++;
  const options = rest[0];
  const entry = { address: '127.0.0.1', family: 4 };
  queueMicrotask(() => options?.all ? callback(null, [entry]) : callback(null, entry.address, entry.family));
});
wrap(dns.promises, 'lookup', () => async function (host, options) {
  if (!local(host)) throw fail('dns.promises.lookup');
  stats.syntheticLookups++;
  const entry = { address: '127.0.0.1', family: 4 };
  return options?.all ? [entry] : entry;
});
for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
  for (const target of [dns, dns.Resolver.prototype]) wrap(target, name, () => function (...args) {
    const error = fail(`dns.${name}`); const callback = args.at(-1);
    if (typeof callback !== 'function') throw error;
    queueMicrotask(() => callback(error));
  });
  for (const target of [dns.promises, dns.promises.Resolver.prototype]) wrap(target, name, () => async function () { throw fail(`dns.promises.${name}`); });
}
wrap(globalThis, 'fetch', original => function (input, init) {
  let url;
  try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
  catch { return Promise.reject(fail('fetch.invalid-url')); }
  // The production preload initializes native fetch with a purely local data: URL.
  if (url.protocol === 'data:') { stats.allowedDataFetches++; return Reflect.apply(original, this, [input, init]); }
  if (url.origin !== registry.origin) return Promise.reject(fail('fetch.external-origin'));
  return Reflect.apply(original, this, [input, init]);
});
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) wrap(childProcess, name, () => function () { throw fail(`child_process.${name}`); });
wrap(workerThreads, 'Worker', OriginalWorker => class OfflineVerifiedWorker extends OriginalWorker {
  constructor(filename, options = {}) {
    const entry = filename instanceof URL ? fileURLToPath(filename) : path.resolve(filename);
    const argv = options.execArgv ?? process.execArgv;
    const failsafeIndex = argv.findIndex((value, index) => value === '--import' && argv[index + 1] === import.meta.url);
    const policyIndex = argv.findIndex((value, index) => value === '--import' && argv[index + 1] === process.env.IUM_PNPM_SMOKE_PRELOAD);
    if (options.eval || options.env !== undefined || !entry.toLowerCase().startsWith(pnpmRoot.toLowerCase()) || failsafeIndex < 0 || policyIndex <= failsafeIndex) throw fail('worker.unprotected');
    // Do not add argv here: this test must observe production's inherited --import chain.
    super(filename, options);
    stats.workersStarted++;
    stats.workerIds.push(this.threadId);
  }
});
syncBuiltinESMExports();
const caseRoot = path.resolve(process.env.IUM_PNPM_SMOKE_CASE_DIR) + path.sep;
const pnpmRoot = path.resolve(process.env.IUM_PNPM_SMOKE_PNPM_ROOT) + path.sep;
function inspectConfigRead(value) {
  const filename = value instanceof URL ? fileURLToPath(value) : typeof value === 'string' || Buffer.isBuffer(value) ? String(value) : null;
  if (!filename) return;
  const absolute = path.resolve(filename);
  const basename = path.basename(absolute).toLowerCase();
  if (!basename.endsWith('.npmrc') && !['npmrc', '.pnpmrc', 'rc', '.credentials.yaml', 'auth.json', 'server-credentials.json'].includes(basename)) return;
  if (!absolute.toLowerCase().startsWith(caseRoot.toLowerCase()) && !absolute.toLowerCase().startsWith(pnpmRoot.toLowerCase())) {
    stats.deniedConfigReads++;
    throw Object.assign(new Error('Offline fixture refused a non-isolated configuration read'), { code: 'ERR_PNPM_SMOKE_REAL_CONFIG_FORBIDDEN' });
  }
  stats.configReads.push(absolute);
}
for (const key of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream']) wrap(fs, key, original => function (filename, ...rest) {
  inspectConfigRead(filename); return Reflect.apply(original, this, [filename, ...rest]);
});
for (const key of ['readFile', 'open']) wrap(fs.promises, key, original => function (filename, ...rest) {
  inspectConfigRead(filename); return Reflect.apply(original, this, [filename, ...rest]);
});
syncBuiltinESMExports();
const modulePaths = JSON.parse(process.env.IUM_PNPM_SMOKE_MODULES);
const modules = modulePaths.map(url => { const file = fileURLToPath(url); const bytes = fs.readFileSync(file); return { file, sha256: createHash('sha256').update(bytes).digest('hex') }; });
process.on('exit', code => {
  const result = {
    schemaVersion: 1, case: process.env.IUM_PNPM_SMOKE_CASE, recorded: true, threadId: workerThreads.threadId, isMainThread: workerThreads.isMainThread,
    nodeVersion: process.versions.node, electronVersion: process.versions.electron,
    exitCode: code, execArgv: process.execArgv, pnpmEntry: process.argv[1],
    modules, failsafe: stats,
  };
  const destination = workerThreads.isMainThread ? resultFile : resultFile.replace(/\.json$/, `.worker-${workerThreads.threadId}.json`);
  fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
});
