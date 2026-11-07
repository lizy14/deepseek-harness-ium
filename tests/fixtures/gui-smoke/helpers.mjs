import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

export const hash = data => createHash('sha256').update(data).digest('hex');
export const hashFile = file => hash(fs.readFileSync(file));
export const labels = Object.freeze({
  panels: /^(Global panels|全局面板)$/,
  plugins: /^(Plugins|插件)$/,
  addPlugin: /^(Add plugin|添加插件)$/,
  settings: /^(Settings|设置)$/,
  models: /^(Models|模型)$/,
  sidebar: /^(Open sidebar|打开侧边栏)$/,
  account: /^(Account|Account menu|账号与余额|账号菜单)$/,
});
const forbiddenCopy = [
  'Sign in to your DeepSeek account', 'Use your DeepSeek account to get started',
  'Configure the official DeepSeek provider', 'You are not signed in to DeepSeek Harness',
  '登录 DeepSeek 账号', '配置 DeepSeek 官方模型', '当前未登录 DeepSeek Harness',
];

export function hostname(value) {
  if (typeof value !== 'string') return '';
  try { return new URL(value.includes('://') ? value : 'http://' + value).hostname.toLowerCase().replace(/\.+$/, ''); }
  catch { return ''; }
}
export function isDeepSeek(value) {
  const host = hostname(value);
  return ['deepseek.com', 'deepseeksvc.com'].some(domain => host === domain || host.endsWith('.' + domain));
}
export function routeSummary(value) {
  try { const url = new URL(value); return { protocol: url.protocol, hostname: url.hostname, pathname: url.pathname }; }
  catch { return { protocol: 'invalid:', hostname: '', pathname: '' }; }
}
export function assertNonSynced(directory) {
  if (!path.isAbsolute(directory)) throw new Error('GUI smoke directories must be absolute');
  let existing = path.resolve(directory);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const real = fs.existsSync(existing) ? fs.realpathSync.native(existing) : existing;
  if (/(^|[\\/])OneDrive(?: - [^\\/]+)?([\\/]|$)/i.test(real)) throw new Error('GUI smoke must run outside OneDrive');
}
export function newRunDirectory(work) {
  assertNonSynced(work);
  const parent = path.join(work, 'gui-smoke');
  assertNonSynced(parent);
  fs.mkdirSync(parent, { recursive: true });
  const directory = path.join(parent, 'run-' + randomUUID());
  fs.mkdirSync(directory, { recursive: false });
  return directory;
}
export function writeResult(file, result) {
  const target = path.resolve(file);
  const temporary = target + '.' + randomUUID() + '.tmp';
  if (path.dirname(target) !== path.dirname(temporary)) throw new Error('Unexpected result staging path');
  fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(temporary, target);
}
export function parseDevToolsPort(text) {
  const [number, endpoint] = text.trim().split(/\r?\n/);
  const port = Number(number);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(endpoint ?? '')) throw new Error('DevToolsActivePort is incomplete or invalid');
  return { port, endpoint, url: `ws://127.0.0.1:${port}${endpoint}` };
}
export function assertOwnedCdpPid(processInfo, launchedPid) {
  const id = Number(processInfo?.processInfo?.find(value => value.type === 'browser')?.id);
  if (!Number.isSafeInteger(launchedPid) || launchedPid < 1 || id !== launchedPid) throw new Error('CDP browser PID is not the process launched by this run');
  return id;
}
export function readAudit(file) {
  if (!fs.existsSync(file)) return { present: false, records: [], attempts: 0 };
  const stat = fs.statSync(file);
  if (stat.size > 2 * 1024 * 1024) throw new Error('Production policy audit is unexpectedly large');
  const records = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    const value = JSON.parse(line);
    if (typeof value.hostname !== 'string' || typeof value.mechanism !== 'string') throw new Error('Malformed production policy audit record');
    return { hostname: hostname(value.hostname), mechanism: value.mechanism.slice(0, 100), deepseek: isDeepSeek(value.hostname) };
  });
  return { present: true, records, attempts: records.filter(record => record.deepseek).length };
}
export function summarizeDom(raw, stage) {
  const forcedLogin = forbiddenCopy.filter(value => raw.body.includes(value));
  const known = name => Object.values(labels).some(expression => expression.test(name));
  return {
    stage, route: routeSummary(raw.url), rootPresent: raw.rootPresent, rootVisible: raw.rootVisible,
    rootInert: raw.rootInert, bodyLength: raw.body.length, bodySha256: hash(raw.body),
    recognizedButtons: raw.buttons.filter(known), recognizedHeadings: raw.headings.filter(known),
    dialogCount: raw.dialogCount, forcedLogin,
  };
}
export function assessUi(evidence) {
  const failures = [];
  for (const stage of ['main', 'plugins', 'models']) {
    const page = evidence[stage];
    if (!page?.rootPresent || !page.rootVisible) failures.push(stage + ': application root is not visible');
    if (page?.forcedLogin?.length) failures.push(stage + ': DeepSeek credential onboarding is visible');
    if (stage !== 'models' && page?.rootInert) failures.push(stage + ': application root is inert');
  }
  if (!evidence.main?.pluginsReachable || !evidence.main?.settingsReachable) failures.push('Main navigation is not usable');
  if (!evidence.plugins?.headingVisible || !evidence.plugins?.addControlVisible || !evidence.plugins?.addControlEnabled) failures.push('Plugins entry or its add control is not usable');
  if (!evidence.models?.dialogVisible || !evidence.models?.selected || !evidence.models?.headingVisible) failures.push('Models settings are not reachable');
  if (evidence.models?.accountControlVisible) failures.push('DeepSeek account settings remain visible');
  return failures;
}
export function assessRun({ exit, ui, audit, proxy, cdpAttempts, artifactUnchanged, ready }) {
  const failures = assessUi(ui);
  if (!ready) failures.push('No CDP/application readiness');
  if (!exit || exit.closed !== true || exit.status !== 0 || exit.signal || exit.spawnError || exit.forced || exit.premature || exit.timedOut) failures.push('Owned Desktop did not complete a clean controlled exit');
  if (!artifactUnchanged) failures.push('Artifact bytes changed during the smoke');
  if (audit.attempts > 0) failures.push('A built-in producer attempted a DeepSeek request (audit)');
  if (proxy.records.some(record => record.deepseek)) failures.push('A DeepSeek destination reached the rejecting proxy');
  if (proxy.records.length > 0) failures.push('Unexpected proxy egress attempt; the GUI test makes no external requests');
  if (cdpAttempts.some(record => record.deepseek)) failures.push('A renderer attempted a DeepSeek request');
  return failures;
}

/** Never forwards, resolves, or contacts a supplied destination. */
export async function startOfflineServices() {
  const records = [], registryRequests = [], sockets = new Set();
  const capture = (method, value) => records.push({ method, hostname: hostname(value) || '[invalid]', deepseek: isDeepSeek(value) });
  const proxy = http.createServer((request, response) => {
    capture(request.method ?? 'UNKNOWN', request.url ?? '');
    response.writeHead(502, { 'content-type': 'text/plain', connection: 'close' }); response.end('GUI smoke proxy refuses all forwarding');
  });
  proxy.on('connect', (request, socket) => { capture('CONNECT', request.url ?? ''); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
  proxy.on('upgrade', (request, socket) => { capture('UPGRADE', request.url ?? ''); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
  const registry = http.createServer((request, response) => {
    let pathname;
    try { pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; } catch { pathname = '[invalid]'; }
    registryRequests.push({ method: request.method, pathname: pathname.slice(0, 300) });
    if (request.method === 'GET' && ['/', '/-/ping'].includes(pathname)) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, name: 'ium-offline-gui-registry' }));
    } else {
      response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'Offline GUI fixture has no installable packages' }));
    }
  });
  for (const server of [proxy, registry]) server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { await listen(proxy); await listen(registry); }
  catch (error) { for (const socket of sockets) socket.destroy(); proxy.close(); registry.close(); throw error; }
  return {
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`, registryUrl: `http://127.0.0.1:${registry.address().port}/`, records, registryRequests,
    async close() { for (const socket of sockets) socket.destroy(); await Promise.all([proxy, registry].map(server => new Promise(resolve => server.close(resolve)))); },
  };
}

/** Construct an allowlisted child environment; do not copy credentials or user npm settings. */
export function isolatedEnvironment(directory, services, inherited = process.env) {
  const values = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'SYSTEMDRIVE']) if (inherited[key]) values[key] = inherited[key];
  const folders = Object.fromEntries(['home', 'appdata', 'localappdata', 'temp', 'config', 'cache', 'data', 'dsh-home', 'user-data', 'npm-global', 'pnpm-home'].map(name => {
    const destination = path.join(directory, name); fs.mkdirSync(destination, { recursive: true }); return [name, destination];
  }));
  const userNpm = path.join(directory, 'empty-user.npmrc'), globalNpm = path.join(directory, 'empty-global.npmrc');
  fs.writeFileSync(userNpm, '', { flag: 'wx' }); fs.writeFileSync(globalNpm, '', { flag: 'wx' });
  Object.assign(values, {
    PATH: [path.dirname(process.execPath), inherited.SystemRoot && path.join(inherited.SystemRoot, 'System32')].filter(Boolean).join(path.delimiter),
    HOME: folders.home, USERPROFILE: folders.home, APPDATA: folders.appdata, LOCALAPPDATA: folders.localappdata,
    TEMP: folders.temp, TMP: folders.temp, TMPDIR: folders.temp,
    XDG_CONFIG_HOME: folders.config, XDG_CACHE_HOME: folders.cache, XDG_DATA_HOME: folders.data,
    IUM_DSH_HOME: folders['dsh-home'], IUM_USER_DATA_DIR: folders['user-data'], DSH_HOME: folders['dsh-home'],
    IUM_NPM_REGISTRY: services.registryUrl, npm_config_registry: services.registryUrl,
    npm_config_userconfig: userNpm, npm_config_globalconfig: globalNpm, npm_config_cache: folders.cache, npm_config_prefix: folders['npm-global'],
    PNPM_HOME: folders['pnpm-home'], CI: 'true', NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false', npm_config_ignore_scripts: 'true',
    HTTP_PROXY: services.proxyUrl, HTTPS_PROXY: services.proxyUrl, ALL_PROXY: services.proxyUrl,
    http_proxy: services.proxyUrl, https_proxy: services.proxyUrl, all_proxy: services.proxyUrl,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1', NODE_USE_ENV_PROXY: '1',
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', ELECTRON_ENABLE_LOGGING: '1',
  });
  return { env: values, folders, emptyNpmConfigs: [userNpm, globalNpm] };
}

/** Read only the identity entry, not user data, from a packed ASAR. */
export function readArtifactIdentity(archive) {
  const fd = fs.openSync(archive, 'r');
  const read = (size, offset) => {
    const output = Buffer.alloc(size); let count = 0;
    while (count < size) { const n = fs.readSync(fd, output, count, size - count, offset + count); if (!n) throw new Error('Truncated ASAR input'); count += n; }
    return output;
  };
  try {
    const prefix = read(16, 0), headerSize = prefix.readUInt32LE(12), dataOffset = 8 + prefix.readUInt32LE(4), size = fs.fstatSync(fd).size;
    if (headerSize > 64 * 1024 * 1024 || dataOffset < headerSize + 16 || dataOffset > size) throw new Error('Invalid ASAR header');
    const tree = JSON.parse(read(headerSize, 16));
    const entry = tree.files?.['package.json'];
    if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(entry.size) || entry.size > 1024 * 1024) throw new Error('Packed application manifest is unavailable');
    const offset = dataOffset + Number(entry.offset);
    if (!Number.isSafeInteger(offset) || offset < dataOffset || offset + entry.size > size) throw new Error('Invalid application manifest bounds');
    const data = read(entry.size, offset);
    if (entry.integrity?.algorithm !== 'SHA256' || entry.integrity.hash !== hash(data)) throw new Error('Application manifest integrity failed');
    return JSON.parse(data);
  } finally { fs.closeSync(fd); }
}
export function validateIdentity(manifest, profile, expectedVersion) {
  if (manifest.name !== profile.identity.packageName || manifest.main !== 'lib/ium-bootstrap.js' || manifest.dshDesktopAppId !== profile.identity.appId) throw new Error('Refusing to launch a non-Ium application');
  if (manifest.version !== expectedVersion) throw new Error('Artifact version differs from the requested GUI candidate');
  if ('dshMandatoryUpdatePolicy' in manifest) throw new Error('Artifact unexpectedly carries a mandatory update policy');
}
export function safeError(error) {
  return String(error?.message ?? error).replace(/(?:https?|wss?):\/\/[^\s]+/g, value => {
    const route = routeSummary(value); return route.protocol + '//' + route.hostname + route.pathname;
  }).replace(/(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s&,]+/gi, '[redacted]').slice(0, 1200);
}
