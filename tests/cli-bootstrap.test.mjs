import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { root, work } from '../scripts/lib.mjs';

function fixture({ refusePolicy = false } = {}) {
  const directory = path.join(work, 'cli-bootstrap-tests', randomUUID());
  const app = path.join(directory, 'Application spaces 中文 # %');
  const library = path.join(app, 'resources', 'app.asar', 'lib');
  const carrier = path.join(app, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib');
  const home = path.join(directory, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  for (const dir of [library, carrier, appData, path.join(home, '.dsh')]) fs.mkdirSync(dir, { recursive: true });
  const write = (file, value) => fs.writeFileSync(file, value, { flag: 'wx' });
  write(path.join(home, '.dsh', 'original-sentinel'), 'keep original data');
  write(path.join(app, 'resources', 'app.asar', 'package.json'), '{"type":"module"}');
  write(path.join(carrier, '..', 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(root, 'overlays/desktop/ium-cli-bootstrap.mjs'), path.join(library, 'ium-cli-bootstrap.mjs'));
  fs.copyFileSync(path.join(root, 'overlays/desktop/ium-identity.mjs'), path.join(library, 'ium-identity.mjs'));
  fs.copyFileSync(path.join(root, 'profiles/work.json'), path.join(library, 'ium-build.json'));
  write(path.join(library, 'ium-node-preload.js'), refusePolicy
    ? 'throw new Error("fixture policy refused");\n'
    : 'globalThis.iumFixtureOrder = ["policy"];\n');
  write(path.join(carrier, 'first-dependency.js'), [
    'import fs from "node:fs";',
    'fs.writeFileSync(process.env.IUM_FIXTURE_DEPENDENCY, "loaded");',
    'if (globalThis.iumFixtureOrder?.[0] !== "policy") throw Error("application dependency preceded policy");',
    'globalThis.iumFixtureOrder.push("dependency");',
  ].join('\n'));
  write(path.join(carrier, 'cli.js'), [
    'import "./first-dependency.js";',
    'import fs from "node:fs";',
    'export async function runDesktopCli(runtimeDir, supportDir, options) {',
    '  globalThis.iumFixtureOrder.push("carrier");',
    '  fs.writeFileSync(process.env.IUM_FIXTURE_RESULT, JSON.stringify({runtimeDir,supportDir,options,order:globalThis.iumFixtureOrder,argv:process.argv.slice(2),cwd:process.cwd(),home:process.env.DSH_HOME,profile:process.env.DSH_PROFILE??null,profileDir:process.env.DSH_PROFILE_DIR??null,parentSession:process.env.DSH_SESSION_ID??null,parentWeb:process.env.DSH_WEB_URL??null,parentShell:process.env.DSH_SHELL??null}));',
    '}',
  ].join('\n'));
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'SYSTEMDRIVE']) if (process.env[key]) env[key] = process.env[key];
  const result = path.join(directory, 'result.json'), dependency = path.join(directory, 'dependency-loaded');
  Object.assign(env, {
    PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home, APPDATA: appData,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), TEMP: directory, TMP: directory, TMPDIR: directory,
    DSH_HOME: path.join(home, '.dsh'), DSH_PROFILE: 'parent-profile', DSH_PROFILE_DIR: path.join(home, '.dsh', 'profiles', 'parent'),
    DSH_SESSION_ID: 'fixture-parent-session', DSH_WEB_URL: 'http://127.0.0.1:9', DSH_SHELL: 'fixture-parent-shell',
    IUM_FIXTURE_RESULT: result, IUM_FIXTURE_DEPENDENCY: dependency,
  });
  return { directory, app, library, home, appData, env, result, dependency, entry: path.join(library, 'ium-cli-bootstrap.mjs') };
}
function run(value, args = []) {
  const stdout = fs.openSync(path.join(value.directory, 'stdout.log'), 'wx');
  const stderr = fs.openSync(path.join(value.directory, 'stderr.log'), 'wx');
  try { return spawnSync(process.execPath, [value.entry, ...args], { cwd: value.directory, env: value.env, stdio: ['ignore', stdout, stderr], timeout: 15000, windowsHide: true }); }
  finally { fs.closeSync(stdout); fs.closeSync(stderr); }
}
const supported = ['win32', 'darwin'].includes(process.platform);

test('CLI resolves application-data roots without Electron and rejects unsupported/relative inputs', async () => {
  const value = fixture();
  const { cliAppDataDirectory } = await import(pathToFileURL(value.entry).href);
  assert.equal(cliAppDataDirectory(value.home, 'win32', { APPDATA: value.appData }), value.appData);
  assert.equal(cliAppDataDirectory(value.home, 'win32', {}), path.join(value.home, 'AppData', 'Roaming'));
  assert.equal(cliAppDataDirectory(value.home, 'darwin', {}), path.join(value.home, 'Library', 'Application Support'));
  assert.throws(() => cliAppDataDirectory('relative', 'win32', {}), /home must be absolute/);
  assert.throws(() => cliAppDataDirectory(value.home, 'win32', { APPDATA: 'relative' }), /APPDATA must be absolute/);
  assert.throws(() => cliAppDataDirectory(value.home, 'linux', {}), /supports Windows and macOS/);
  assert.equal(fs.existsSync(value.result), false);
});

test('CLI completes identity and the declared preload before importing the official carrier', { skip: !supported }, () => {
  const value = fixture();
  const args = ['headless', '--patch', 'fixture settings.yml', 'a task with spaces', ''];
  const child = run(value, args);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, fs.readFileSync(path.join(value.directory, 'stderr.log'), 'utf8'));
  const result = JSON.parse(fs.readFileSync(value.result, 'utf8'));
  assert.deepEqual(result.order, ['policy', 'dependency', 'carrier']);
  assert.deepEqual(result.argv, args);
  assert.equal(result.cwd, value.directory);
  assert.equal(result.home, path.join(value.home, '.dsh-ium'));
  for (const key of ['profile', 'profileDir', 'parentSession', 'parentWeb', 'parentShell']) assert.equal(result[key], null);
  assert.equal(result.runtimeDir, path.join(value.app, 'resources', 'app.asar', 'dsh') + path.sep);
  assert.equal(result.supportDir, path.join(value.app, 'resources', 'runtime') + path.sep);
  assert.equal(result.options.networkPreload, pathToFileURL(path.join(value.library, 'ium-node-preload.js')).href);
  assert.deepEqual(result.options.deploymentPatchFiles, [path.join(value.app, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'ium-work.cordis.yml')]);
  assert.equal(fs.readFileSync(path.join(value.home, '.dsh', 'original-sentinel'), 'utf8'), 'keep original data');
});

test('CLI refuses a failing policy before importing application dependencies', { skip: !supported }, () => {
  const value = fixture({ refusePolicy: true });
  const child = run(value, ['--version']);
  assert.equal(child.error, undefined);
  assert.notEqual(child.status, 0);
  assert.equal(fs.existsSync(value.dependency), false);
  assert.equal(fs.existsSync(value.result), false);
});

test('CLI cannot reuse the original data directory through an override', { skip: !supported }, () => {
  const value = fixture();
  value.env.IUM_DSH_HOME = path.join(value.home, '.dsh');
  const child = run(value, ['web', '--help']);
  assert.notEqual(child.status, 0);
  assert.equal(fs.existsSync(value.dependency), false);
  assert.equal(fs.readFileSync(path.join(value.home, '.dsh', 'original-sentinel'), 'utf8'), 'keep original data');
});
