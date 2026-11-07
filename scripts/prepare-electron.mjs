import fs from 'node:fs';
import path from 'node:path';
import { work, upstream, readJson, run, buildEnvironment } from './lib.mjs';

const packageRoot = path.join(upstream, 'apps/desktop/node_modules/electron');
const manifest = readJson(path.join(packageRoot, 'package.json'));
if (manifest.version !== '44.7.0') throw new Error('Native policy smoke requires the pinned Electron 44.7.0');
const installer = path.join(packageRoot, 'install.js');
const realInstaller = fs.realpathSync.native(installer);
if (!realInstaller.startsWith(fs.realpathSync.native(upstream) + path.sep)) throw new Error('Electron installer escaped the upstream dependency tree');
const env = buildEnvironment({ electron_config_cache: path.join(work, 'electron-cache') });
for (const name of ['ELECTRON_MIRROR', 'ELECTRON_CUSTOM_DIR', 'ELECTRON_CUSTOM_FILENAME', 'ELECTRON_OVERRIDE_DIST_PATH', 'electron_use_remote_checksums', 'npm_config_electron_use_remote_checksums', 'force_no_cache']) delete env[name];
// The pinned package installer verifies its bundled checksums and writes only its own dist/type files.
run(process.execPath, [realInstaller], { cwd: upstream, env });
const platformPath = fs.readFileSync(path.join(packageRoot, 'path.txt'), 'utf8').trim();
if (process.platform !== 'win32' || platformPath !== 'electron.exe') throw new Error('This smoke recipe currently expects the Windows Electron distribution');
const executable = path.join(packageRoot, 'dist', platformPath);
if (!fs.existsSync(executable)) throw new Error('Electron installer did not produce its declared executable');
const result = { version: manifest.version, executable, existingDesktopModified: false, note: 'Stock Electron test distribution, not the installed DSH application.' };
fs.writeFileSync(path.join(work, 'electron-test-distribution.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
