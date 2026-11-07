import fs from 'node:fs';
import path from 'node:path';
import { root, work, upstream, readJson, run, verifyUpstream, buildEnvironment } from './lib.mjs';

const pinned = verifyUpstream();
run(process.execPath, [path.join(root, 'scripts/verify.mjs')]);
const input = readJson(path.join(work, 'source-verification.json'));
const files = [
  'apps/desktop/tests/desktop-package-environment.spec.ts',
  'apps/desktop/tests/installer-packaging.spec.ts',
  'apps/desktop/tests/main-startup.spec.ts',
  'apps/desktop/tests/host-process.spec.ts',
  'apps/desktop/tests/macos-signature.spec.ts',
  'apps/desktop/tests/package-macos.spec.ts',
  'scripts/compile-referenced-projects.spec.ts',
  'scripts/run-gates.spec.ts',
  'scripts/ci-workflow.spec.ts',
];
const cli = path.join(upstream, 'node_modules/vitest/vitest.mjs');
if (!fs.existsSync(cli)) throw new Error('Install upstream dependencies before focused tests');
run(process.execPath, [cli, 'run', '--silent=passed-only', ...files], { cwd: upstream, env: buildEnvironment({ CI: 'true' }) });
fs.writeFileSync(path.join(work, 'focused-test-result.json'), JSON.stringify({ result: 'PASS', upstreamCommit: pinned.commit, sourceInputSha256: input.sourceInputSha256, node: process.versions.node, files, finishedAt: new Date().toISOString(), nativeDesktopSmoke: false }, null, 2) + '\n');
