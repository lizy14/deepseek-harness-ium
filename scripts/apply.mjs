import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, work, upstream, readJson, sha256, within, run, verifyUpstream } from './lib.mjs';

const pinned = verifyUpstream();
const series = readJson(path.join(root, 'patches/series.json'));
const overlays = readJson(path.join(root, 'overlays.json'));
if (series.schemaVersion !== 1 || overlays.schemaVersion !== 1) throw new Error('Unsupported patch/overlay manifest');
const stateFile = path.join(work, 'applied.json');
const previous = fs.existsSync(stateFile) ? readJson(stateFile) : null;
const checkDirectory = path.join(work, 'patch-checks');
fs.mkdirSync(checkDirectory, { recursive: true });
const patchResults = [];
for (const name of series.patches) {
  const file = within(path.join(root, 'patches'), name);
  if (!name.endsWith('.patch') || !fs.existsSync(file)) throw new Error(`Missing reviewed patch: ${name}`);
  const check = run('git', ['apply', '--check', '--whitespace=error-all', file], {
    cwd: upstream, accept: [0, 1], errorFile: path.join(checkDirectory, `${randomUUID()}.txt`),
  });
  if (check === 0) run('git', ['apply', '--whitespace=error-all', file], { cwd: upstream });
  else run('git', ['apply', '--reverse', '--check', file], { cwd: upstream });
  patchResults.push({ path: 'patches/' + name, sha256: sha256(fs.readFileSync(file)), state: check === 0 ? 'applied' : 'already-applied' });
}
const installed = [];
for (const mapping of overlays.files) {
  if (!mapping.source.startsWith('overlays/') && !mapping.source.startsWith('profiles/')) throw new Error('Overlay source is outside the declared public inputs');
  const source = within(root, mapping.source);
  const target = within(upstream, mapping.target);
  const data = fs.readFileSync(source);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (!existing.equals(data)) {
      const owned = previous?.overlays?.find(item => item.source === mapping.source && item.target === mapping.target);
      if (!process.argv.includes('--refresh-overlays') || !owned || owned.sha256 !== sha256(existing)) throw new Error(`Refusing to overwrite a different overlay: ${mapping.target}`);
      fs.writeFileSync(target, data);
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
  }
  installed.push({ ...mapping, sha256: sha256(data) });
}
const state = { schemaVersion: 1, upstreamCommit: pinned.commit, appliedAt: new Date().toISOString(), patches: patchResults, overlays: installed };
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify({ commit: pinned.commit, patches: patchResults.length, overlays: installed.length }, null, 2));
