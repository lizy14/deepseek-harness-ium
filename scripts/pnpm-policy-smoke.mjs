import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = process.env.IUM_WORK_DIR ?? path.join(root, '.work');
if (!path.isAbsolute(work)) throw new Error('IUM_WORK_DIR must be absolute');
const fixture = path.join(root, 'tests/fixtures/pnpm-policy-smoke');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const snapshotArgument = option('--snapshot-dir');
if (!snapshotArgument) throw new Error('Pass --snapshot-dir with a frozen compiled preload/policy snapshot; do not test files being rebuilt');
const snapshot = fs.realpathSync.native(path.resolve(root, snapshotArgument));
const snapshotRoots = [work, path.join(root, '.work')].filter(value => fs.existsSync(value)).map(value => fs.realpathSync.native(value) + path.sep);
if (!snapshotRoots.some(value => snapshot.startsWith(value))) throw new Error('Policy snapshot must be under an isolated build directory');
const snapshotReceipt = readJson(path.join(snapshot, 'snapshot.json'));
const moduleFiles = snapshotReceipt.files.map(record => {
  if (path.basename(record.name) !== record.name || !record.name.startsWith('ium-') || !record.name.endsWith('.js')) throw new Error('Unexpected snapshot module name');
  const file = path.join(snapshot, record.name);
  if (hash(fs.readFileSync(file)) !== record.sha256) throw new Error(`Snapshot hash mismatch: ${record.name}`);
  return { file, sha256: record.sha256 };
});
for (const required of ['ium-node-preload.js', 'ium-network-policy.js']) if (!moduleFiles.some(item => path.basename(item.file) === required)) throw new Error(`Missing snapshot module: ${required}`);
const preload = path.join(snapshot, 'ium-node-preload.js');
const distribution = readJson(path.join(work, 'electron-test-distribution.json'));
if (distribution.version !== '44.7.0' || distribution.existingDesktopModified !== false) throw new Error('Expected the stock Electron 44.7.0 test distribution');
const electron = fs.realpathSync.native(distribution.executable);
if (!electron.startsWith(fs.realpathSync.native(path.join(work, 'upstream')) + path.sep)) throw new Error('Refusing to run an executable outside isolated upstream dependencies');
const packageFile = fs.realpathSync.native(path.join(work, 'upstream/apps/desktop/node_modules/pnpm/package.json'));
const pnpmPackage = readJson(packageFile);
if (pnpmPackage.name !== 'pnpm' || pnpmPackage.version !== '11.28.5') throw new Error('Expected managed pnpm 11.28.5');
const pnpmEntry = fs.realpathSync.native(path.resolve(path.dirname(packageFile), typeof pnpmPackage.bin === 'string' ? pnpmPackage.bin : pnpmPackage.bin.pnpm));
const inputHashes = { electron: hash(fs.readFileSync(electron)), pnpmPackage: hash(fs.readFileSync(packageFile)), pnpmEntry: hash(fs.readFileSync(pnpmEntry)), failsafe: hash(fs.readFileSync(path.join(fixture, 'offline-failsafe.mjs'))), runner: hash(fs.readFileSync(fileURLToPath(import.meta.url))), modules: moduleFiles };
const directory = path.join(work, 'pnpm-policy-smoke', 'run-' + randomUUID());
fs.mkdirSync(directory, { recursive: true });
const packageName = 'ium-offline-pnpm-policy-fixture';
const blockedTarball = `https://download.deepseek.com/${packageName}-1.0.0.tgz`;
const requests = [];
let activeCase = 'initialization';
const registry = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  requests.push({ case: activeCase, method: request.method, pathname: url.pathname });
  if (request.method !== 'GET' || ![`/${packageName}`, `/${packageName}/1.0.0`].includes(url.pathname)) {
    response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'Offline fixture: unknown path' })); return;
  }
  const version = { name: packageName, version: '1.0.0', dist: { tarball: blockedTarball, integrity: 'sha512-' + createHash('sha512').update('never downloaded').digest('base64') } };
  const metadata = url.pathname.endsWith('/1.0.0') ? version : { name: packageName, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': version } };
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(metadata));
});
registry.on('connect', (_request, socket) => { requests.push({ case: activeCase, method: 'CONNECT', pathname: '[unexpected]' }); socket.destroy(); });
await new Promise((resolve, reject) => { registry.once('error', reject); registry.listen(0, '127.0.0.1', resolve); });
const registryUrl = `http://127.0.0.1:${registry.address().port}/`;

function environment(caseDirectory, caseName, resultFile) {
  const dirs = Object.fromEntries(['home', 'appdata', 'localappdata', 'temp', 'config', 'cache', 'data', 'store', 'state', 'global', 'pnpm-home', 'dsh-home'].map(name => {
    const dir = path.join(caseDirectory, name); fs.mkdirSync(dir, { recursive: true }); return [name, dir];
  }));
  const userConfig = path.join(caseDirectory, 'empty-user.npmrc');
  const globalConfig = path.join(caseDirectory, 'empty-global.npmrc');
  fs.writeFileSync(userConfig, ''); fs.writeFileSync(globalConfig, '');
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'SYSTEMDRIVE']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    PATH: [path.dirname(electron), process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32')].filter(Boolean).join(path.delimiter),
    HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata,
    TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp,
    XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_DATA_HOME: dirs.data,
    DSH_HOME: dirs['dsh-home'], ELECTRON_RUN_AS_NODE: '1', CI: 'true', NO_COLOR: '1', NO_UPDATE_NOTIFIER: '1',
    PNPM_HOME: dirs['pnpm-home'], PNPM_MAX_WORKERS: '1', npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
    npm_config_registry: registryUrl, npm_config_cache: dirs.cache, npm_config_store_dir: dirs.store,
    npm_config_state_dir: dirs.state, npm_config_global_dir: dirs.global, npm_config_prefix: dirs.global,
    npm_config_update_notifier: 'false', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_fetch_retries: '0', npm_config_fetch_timeout: '5000', npm_config_manage_package_manager_versions: 'false',
    IUM_PNPM_SMOKE_RESULT: resultFile, IUM_PNPM_SMOKE_CASE: caseName, IUM_PNPM_SMOKE_PRELOAD: pathToFileURL(preload).href,
    IUM_PNPM_SMOKE_REGISTRY: registryUrl, IUM_PNPM_SMOKE_CASE_DIR: caseDirectory, IUM_PNPM_SMOKE_PNPM_ROOT: path.dirname(packageFile), IUM_PNPM_SMOKE_MODULES: JSON.stringify(moduleFiles.map(item => pathToFileURL(item.file).href)),
  });
  return { env, dirs, userConfig, globalConfig };
}
async function runCase(name, arguments_) {
  activeCase = name;
  const caseDirectory = path.join(directory, name); fs.mkdirSync(caseDirectory);
  const project = path.join(caseDirectory, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'ium-offline-smoke-project', private: true, version: '1.0.0', packageManager: 'pnpm@11.28.5' }, null, 2));
  fs.writeFileSync(path.join(project, 'pnpm-workspace.yaml'), `packages:\n  - .\nfetchRetries: 0\nfetchTimeout: 5000\nfetchRetryMintimeout: 1\nfetchRetryMaxtimeout: 1\nstoreDir: ${JSON.stringify(path.join(caseDirectory, 'store'))}\ncacheDir: ${JSON.stringify(path.join(caseDirectory, 'cache'))}\nstateDir: ${JSON.stringify(path.join(caseDirectory, 'state'))}\nmanagePackageManagerVersions: false\n`);
  fs.writeFileSync(path.join(project, '.npmrc'), `registry=${registryUrl}\nignore-scripts=true\nupdate-notifier=false\nmanage-package-manager-versions=false\nfetch-retries=0\nfetch-timeout=5000\n`);
  const resultFile = path.join(caseDirectory, 'child-result.json');
  const isolated = environment(caseDirectory, name, resultFile);
  const args = ['--import', pathToFileURL(path.join(fixture, 'offline-failsafe.mjs')).href, '--import', pathToFileURL(preload).href, '--expose-internals', pnpmEntry, ...arguments_];
  const stdoutFile = path.join(caseDirectory, 'stdout.log'); const stderrFile = path.join(caseDirectory, 'stderr.log');
  const stdout = fs.openSync(stdoutFile, 'wx'); const stderr = fs.openSync(stderrFile, 'wx');
  let processResult;
  try {
    processResult = await new Promise(resolve => {
      let child; let timedOut = false; let spawnError = null;
      try { child = spawn(electron, args, { cwd: project, env: isolated.env, stdio: ['ignore', stdout, stderr], windowsHide: true }); }
      catch (error) { resolve({ status: null, signal: null, timedOut: false, spawnError: error.message }); return; }
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45000);
      child.once('error', error => { spawnError = error.message; });
      child.once('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, timedOut, spawnError }); });
    });
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  let facts = null;
  if (fs.existsSync(resultFile)) facts = readJson(resultFile);
  const workers = fs.readdirSync(caseDirectory).filter(name => /^child-result\.worker-\d+\.json$/.test(name)).map(name => ({ resultFile: path.join(caseDirectory, name), facts: readJson(path.join(caseDirectory, name)) }));
  const auditFile = path.join(isolated.dirs['dsh-home'], 'logs/network-policy-blocks.jsonl');
  const audit = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
  return { name, args, ...processResult, resultFile, facts, workers, auditFile, audit, stdoutFile, stderrFile, stdout: fs.readFileSync(stdoutFile, 'utf8'), stderr: fs.readFileSync(stderrFile, 'utf8'), emptyUserConfig: fs.statSync(isolated.userConfig).size === 0, emptyGlobalConfig: fs.statSync(isolated.globalConfig).size === 0, registryRequests: requests.filter(item => item.case === name) };
}
const cases = [];
let runnerError = null;
try {
  cases.push(await runCase('version', ['--version']));
  cases.push(await runCase('metadata', ['view', `${packageName}@1.0.0`, 'version', '--json', '--registry', registryUrl]));
  cases.push(await runCase('blocked-tarball', ['add', `${packageName}@1.0.0`, '--ignore-scripts', '--lockfile=false', '--reporter=ndjson', '--fetch-retries=0', '--fetch-timeout=5000', '--registry', registryUrl]));
} catch (error) { runnerError = error.stack; }
finally { registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve)); }
const errors = [];
if (runnerError) errors.push(runnerError);
if (cases.length !== 3) errors.push('Not every case ran');
for (const test of cases) {
  if (test.spawnError || test.timedOut || test.signal) errors.push(`${test.name}: abnormal process completion`);
  if (!test.facts?.recorded) { errors.push(`${test.name}: MISSING RESULT FILE is not a pass`); continue; }
  if (test.facts.nodeVersion !== '24.21.0' || test.facts.electronVersion !== '44.7.0') errors.push(`${test.name}: unexpected actual Node/Electron version`);
  if (test.facts.exitCode !== test.status) errors.push(`${test.name}: recorded exit and parent exit disagree`);
  if (test.facts.failsafe.denied !== 0 || test.facts.failsafe.realDnsQueries !== 0 || test.facts.failsafe.externalConnections !== 0 || test.facts.failsafe.deniedConfigReads !== 0) errors.push(`${test.name}: independent failsafe triggered or external networking observed`);
  if (test.facts.failsafe.allowedDataFetches < 1) errors.push(`${test.name}: production preload data initialization was not observed`);
  for (const module of moduleFiles) if (!test.facts.modules.some(record => record.file === module.file && record.sha256 === module.sha256)) errors.push(`${test.name}: compiled input hash was not recorded`);
  const expectedWorkers = [test.facts, ...test.workers.map(item => item.facts)].flatMap(facts => facts.failsafe.workerIds);
  if (expectedWorkers.length !== test.workers.length || expectedWorkers.some(id => !test.workers.some(item => item.facts.threadId === id))) errors.push(`${test.name}: a PNPM Worker result file is missing`);
  for (const worker of test.workers) {
    const facts = worker.facts;
    if (!facts.recorded || facts.isMainThread || facts.exitCode !== 0 || facts.nodeVersion !== '24.21.0' || facts.electronVersion !== '44.7.0' || facts.failsafe.allowedDataFetches < 1 || facts.failsafe.denied !== 0 || facts.failsafe.deniedConfigReads !== 0 || facts.failsafe.realDnsQueries !== 0 || facts.failsafe.externalConnections !== 0) errors.push(`${test.name}: worker ${facts.threadId} was not safely initialized`);
    for (const module of moduleFiles) if (!facts.modules.some(record => record.file === module.file && record.sha256 === module.sha256)) errors.push(`${test.name}: worker input hash mismatch`);
  }
  if (!test.emptyUserConfig || !test.emptyGlobalConfig) errors.push(`${test.name}: npm config isolation failed`);
  if (test.registryRequests.some(request => request.method !== 'GET' || ![`/${packageName}`, `/${packageName}/1.0.0`].includes(request.pathname))) errors.push(`${test.name}: unexpected registry request`);
}
const version = cases.find(test => test.name === 'version');
const metadata = cases.find(test => test.name === 'metadata');
const blocked = cases.find(test => test.name === 'blocked-tarball');
if (!version || version.status !== 0 || version.stdout.trim() !== '11.28.5') errors.push('Actual PNPM version probe did not pass');
if (!metadata || metadata.status !== 0 || metadata.stdout.trim() !== '"1.0.0"' || metadata.registryRequests.length === 0 || metadata.audit.length !== 0) errors.push('Allowed loopback metadata request did not pass');
if (!blocked || blocked.status === 0 || blocked.status === null || blocked.registryRequests.length === 0 || !blocked.audit.some(event => event.hostname === 'download.deepseek.com')) errors.push('Blocked tarball was not rejected by Ium policy after successful metadata');
const packageErrors = (blocked?.stdout ?? '').split(/\r?\n/).filter(Boolean).flatMap(line => { try { const record = JSON.parse(line); return record?.level === 'error' ? [record] : []; } catch { return []; } });
if (!packageErrors.some(record => record.resource === blockedTarball && record.attempts === 1)) errors.push('PNPM did not identify the blocked tarball as its bounded package-fetch failure');
for (const module of moduleFiles) if (hash(fs.readFileSync(module.file)) !== module.sha256) errors.push('Snapshot changed during test');
if (hash(fs.readFileSync(path.join(fixture, 'offline-failsafe.mjs'))) !== inputHashes.failsafe || hash(fs.readFileSync(fileURLToPath(import.meta.url))) !== inputHashes.runner) errors.push('Test implementation changed during the run');
const summary = { schemaVersion: 1, result: errors.length ? 'FAIL' : 'PASS', snapshotOnly: true, packagedDesktopAcceptance: false, directory, electron, pnpmEntry, pnpmVersion: pnpmPackage.version, inputHashes, registryUrl, blockedTarball, requests, cases, errors, scope: 'Real managed PNPM under stock Electron Node-mode, offline registry; not GUI or complete PackageManager lifecycle coverage' };
const receipt = path.join(directory, 'result.json'); fs.writeFileSync(receipt, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ result: summary.result, receipt, actualNodeVersions: cases.map(test => test.facts?.nodeVersion ?? null), exits: cases.map(test => ({ name: test.name, status: test.status, resultFilePresent: Boolean(test.facts), failsafeDenied: test.facts?.failsafe.denied ?? null })), modules: moduleFiles, errors }, null, 2));
if (errors.length) process.exitCode = 1;
