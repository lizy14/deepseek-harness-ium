import path from 'node:path';
import { root, work, upstream, run, verifyUpstream, pnpmEntry, buildEnvironment } from './lib.mjs';

verifyUpstream();
const entry = pnpmEntry();
const registry = process.env.IUM_NPM_REGISTRY ?? process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
const env = buildEnvironment({ CI: 'true', NPM_CONFIG_CACHE: path.join(work, 'npm-cache') });
const args = [entry, 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', path.join(work, 'pnpm-store')];
if (registry) {
  const parsed = new URL(registry);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Registry URL must not contain credentials, query or fragment');
  args.push('--registry=' + parsed.href);
  env.npm_config_registry = parsed.href;
}
run(process.execPath, args, { cwd: root, env });
run(process.execPath, args, { cwd: upstream, env });
if (process.argv.includes('--build-reviewed-deps')) {
  // These native dependency scripts are explicitly allowed by the pinned upstream workspace policy.
  run(process.execPath, [entry, 'rebuild', 'esbuild', 'node-pty', 'koffi'], { cwd: upstream, env });
}
console.log('Locked dependencies installed; unrequested lifecycle scripts were not run.');
