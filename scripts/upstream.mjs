import fs from 'node:fs';
import path from 'node:path';
import { root, work, upstream, lock, run, verifyUpstream } from './lib.mjs';

const pinned = lock();
if (!fs.existsSync(upstream)) {
  fs.mkdirSync(work, { recursive: true });
  run('git', ['clone', '--depth', '1', '--branch', pinned.ref.replace(/^refs\/tags\//, ''), '--no-recurse-submodules', pinned.repository, upstream], {
    cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}
const verified = verifyUpstream();
console.log(JSON.stringify({ upstream, commit: verified.commit, version: verified.version, note: 'Existing source edits were not reset or removed.' }, null, 2));
