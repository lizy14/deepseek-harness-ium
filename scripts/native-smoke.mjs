import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { root, work, upstream, readJson, sha256, buildEnvironment } from './lib.mjs';

const distribution = readJson(path.join(work, 'electron-test-distribution.json'));
if (distribution.version !== '44.7.0') throw new Error('Unexpected Electron test distribution');
const executable = fs.realpathSync.native(distribution.executable);
if (!executable.startsWith(fs.realpathSync.native(upstream) + path.sep)) throw new Error('Refusing to launch an Electron outside the isolated dependency tree');
const module = process.argv.includes('--compiled')
  ? path.join(upstream, 'apps/desktop/lib/ium-network-policy.js')
  : path.join(root, 'overlays/desktop/ium-network-policy.mjs');
const expectedHash = sha256(fs.readFileSync(module));
const directory = path.join(work, 'native-smoke', randomUUID());
fs.mkdirSync(directory, { recursive: true });
const stdout = fs.openSync(path.join(directory, 'stdout.log'), 'wx');
const stderr = fs.openSync(path.join(directory, 'stderr.log'), 'wx');
let result;
try {
  result = spawnSync(executable, [path.join(root, 'tests/fixtures/electron-policy-smoke')], {
    cwd: root,
    env: buildEnvironment({ IUM_POLICY_SMOKE_DIR: directory, IUM_POLICY_MODULE: pathToFileURL(module).href }),
    stdio: ['ignore', stdout, stderr],
    windowsHide: true,
    timeout: 60000,
  });
} finally { fs.closeSync(stdout); fs.closeSync(stderr); }
const resultFile = path.join(directory, 'network-policy-native-smoke.json');
const facts = fs.existsSync(resultFile) ? readJson(resultFile) : null;
const summary = { schemaVersion: 1, directory, sourcePolicySha256: expectedHash, processStatus: result.status, processSignal: result.signal, spawnError: result.error?.message ?? null, facts, result: 'FAIL' };
if (!result.error && result.status === 0 && facts?.result === 'PASS' && facts.sourcePolicySha256 === expectedHash && facts.forbiddenProxyAttempts === 0 && facts.independentNodeFailsafe?.denied === 0) summary.result = 'PASS';
const receipt = path.join(work, 'native-smoke-result.json');
if (fs.existsSync(receipt)) readJson(receipt);
fs.writeFileSync(receipt, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ result: summary.result, directory, processStatus: result.status, processSignal: result.signal, sourcePolicySha256: expectedHash, nativeComponentOnly: true }, null, 2));
if (summary.result !== 'PASS') throw new Error(`Native policy smoke failed; inspect ${directory}`);
