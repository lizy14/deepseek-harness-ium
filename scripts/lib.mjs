import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const root = fileURLToPath(new URL('../', import.meta.url));
const configuredWork = process.env.IUM_WORK_DIR;
if (configuredWork !== undefined && !path.isAbsolute(configuredWork)) throw new Error('IUM_WORK_DIR must be an absolute isolated build directory');
export const work = configuredWork ?? path.join(root, '.work');
export const upstream = path.join(work, 'upstream');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function lock() {
  const value = readJson(path.join(root, 'upstream.lock.json'));
  if (value.schemaVersion !== 1 || value.repository !== 'https://github.com/deepseek-ai/deepseek-harness.git' || !/^[a-f0-9]{40}$/.test(value.commit)) throw new Error('Unsupported or invalid upstream lock');
  return value;
}
export function within(base, relative) {
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').includes('..') || relative.split('/').includes('.git')) throw new Error(`Unsafe repository-relative path: ${relative}`);
  const target = path.resolve(base, relative);
  const boundary = path.resolve(base) + path.sep;
  if (!target.startsWith(boundary)) throw new Error('Path escaped its repository root');
  return target;
}
export function run(command, args, { cwd = root, env = process.env, outputFile, errorFile, accept = [0] } = {}) {
  console.log('+', command, ...args);
  const descriptor = outputFile === undefined ? undefined : fs.openSync(outputFile, 'wx');
  let errorDescriptor;
  let result;
  try {
    errorDescriptor = errorFile === undefined ? undefined : fs.openSync(errorFile, 'wx');
    result = spawnSync(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', descriptor ?? 'inherit', errorDescriptor ?? 'inherit'] });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (errorDescriptor !== undefined) fs.closeSync(errorDescriptor);
  }
  if (result.error) throw result.error;
  if (!accept.includes(result.status)) throw new Error(`Command failed: ${command} (status=${result.status}, signal=${result.signal ?? 'none'})${errorFile ? `; diagnostics: ${errorFile}` : ''}`);
  return result.status;
}
export function capture(command, args, options = {}) {
  const { trim = true, ...runOptions } = options;
  const directory = path.join(work, 'command-output'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}.txt`);
  run(command, args, { ...runOptions, outputFile: file });
  const output = fs.readFileSync(file, 'utf8');
  return trim ? output.trim() : output;
}
export function verifyUpstream() {
  if (!fs.existsSync(path.join(upstream, '.git'))) throw new Error('Run npm run upstream first');
  const expected = lock();
  const actual = capture('git', ['rev-parse', 'HEAD'], { cwd: upstream });
  if (actual !== expected.commit) throw new Error(`Upstream commit mismatch: expected ${expected.commit}, got ${actual}`);
  return expected;
}
export function pnpmEntry() {
  const packageRoot = path.join(work, 'toolchain', 'node_modules', 'pnpm');
  const localManifest = path.join(packageRoot, 'package.json');
  let candidate = process.env.IUM_PNPM_ENTRY;
  if (candidate === undefined) {
    if (!fs.existsSync(localManifest)) throw new Error('Run npm run toolchain or set IUM_PNPM_ENTRY');
    const bin = readJson(localManifest).bin;
    candidate = within(packageRoot, typeof bin === 'string' ? bin : bin.pnpm);
  }
  if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) throw new Error('IUM_PNPM_ENTRY must name an existing absolute pnpm CLI file');
  const manifest = readJson(path.resolve(path.dirname(candidate), '..', 'package.json'));
  if (manifest.name !== 'pnpm' || manifest.version !== lock().toolchain.pnpm) throw new Error('pnpm does not match the pinned toolchain');
  return candidate;
}
export function buildEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:DSH_|DEEPSEEK_|CSC_|WIN_CSC_|APPLE_)/i.test(key) || /(?:TOKEN|PASSWORD|SECRET|API_?KEY)/i.test(key)) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const pathEntry = Object.entries(env).find(([key]) => key.toLowerCase() === 'path');
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = path.dirname(process.execPath) + path.delimiter + (pathEntry?.[1] ?? '');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Ium builds refuse disabled TLS certificate validation');
  const temporary = process.env.IUM_BUILD_TEMP_DIR ?? path.join(work, 'tmp');
  if (!path.isAbsolute(temporary)) throw new Error('IUM_BUILD_TEMP_DIR must be absolute');
  fs.mkdirSync(temporary, { recursive: true });
  return {
    ...env,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    DSH_HOME: path.join(work, 'build-home'),
    IUM_DSH_HOME: path.join(work, 'build-home'),
    IUM_USER_DATA_DIR: path.join(work, 'build-user-data'),
    ...extra,
  };
}
