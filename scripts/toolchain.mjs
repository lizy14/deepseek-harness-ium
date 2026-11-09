import fs from 'node:fs';
import path from 'node:path';
import { work, lock, run, pnpmEntry, buildEnvironment } from './lib.mjs';

const pinned = lock();
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 9)) throw new Error('Node >=24.9 is required');
if (process.env.IUM_PNPM_ENTRY === undefined) {
  const directory = path.join(work, 'toolchain');
  const manifestPath = path.join(directory, 'package.json');
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify({ name: 'ium-local-toolchain', private: true }) + '\n', { flag: 'wx' });
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [
    path.join(executableDirectory, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(executableDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  const npm = candidates.find(file => fs.existsSync(file));
  if (!npm) throw new Error('Cannot locate npm beside Node; set IUM_PNPM_ENTRY instead');
  const env = buildEnvironment({ NPM_CONFIG_CACHE: path.join(work, 'npm-cache') });
  const registry = process.env.IUM_NPM_REGISTRY ?? process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
  const args = [npm, 'install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `pnpm@${pinned.toolchain.pnpm}`];
  if (registry) {
    const parsed = new URL(registry);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Registry URL must not contain credentials, query or fragment');
    args.push('--registry=' + parsed.href);
  }
  run(process.execPath, args, { env });
}
const entry = pnpmEntry();
run(process.execPath, [entry, '--version'], { env: buildEnvironment() });
console.log(JSON.stringify({ node: process.versions.node, pnpm: pinned.toolchain.pnpm, entry }, null, 2));
