import fs from 'node:fs';
import path from 'node:path';
import { root, work, upstream, readJson, sha256, within, run, capture, verifyUpstream } from './lib.mjs';

const pinned = verifyUpstream();
const state = readJson(path.join(work, 'applied.json'));
if (state.upstreamCommit !== pinned.commit) throw new Error('Applied state belongs to another upstream commit');
const groups = readJson(path.join(root, 'patches/groups.json'));
const overlays = readJson(path.join(root, 'overlays.json'));
if (groups.schemaVersion !== 1 || !Array.isArray(groups.groups) || groups.groups.length === 0) throw new Error('Unsupported patch groups manifest');
const patches = groups.groups.map(group => group.file);
if (patches.some(name => typeof name !== 'string' || !name.endsWith('.patch')) || new Set(patches).size !== patches.length) throw new Error('Invalid or duplicate patch group name');
if (JSON.stringify(state.patches.map(item => item.path)) !== JSON.stringify(patches.map(name => 'patches/' + name)) || state.overlays.length !== overlays.files.length) throw new Error('Applied inputs differ from the declared manifests');
const sections = text => new Map(text.split(/(?=^diff --git )/m).filter(part => part.startsWith('diff --git ')).map(part => [part.split('\n', 1)[0], part.replace(/\n+$/, '') + '\n']));
const expected = new Map();
for (const name of patches) {
  const relative = 'patches/' + name;
  const data = fs.readFileSync(within(root, relative));
  const recorded = state.patches.find(item => item.path === relative);
  if (!recorded || recorded.sha256 !== sha256(data)) throw new Error(`Patch changed after application: ${relative}`);
  for (const [file, content] of sections(data.toString('utf8'))) {
    if (expected.has(file)) throw new Error('Patch series currently requires non-overlapping file sets');
    expected.set(file, content);
  }
  run('git', ['apply', '--reverse', '--check', within(root, relative)], { cwd: upstream });
}
const actualDiff = capture('git', ['-c', 'diff.algorithm=myers', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', '--unified=3', '--'], { cwd: upstream, trim: false });
const actual = sections(actualDiff);
if (actual.size !== expected.size) throw new Error('Unexpected tracked edits in the upstream checkout');
for (const [file, content] of expected) if (actual.get(file) !== content) throw new Error(`Tracked source differs from the reviewed patch: ${file}`);
for (const mapping of overlays.files) {
  const source = fs.readFileSync(within(root, mapping.source));
  const installed = fs.readFileSync(within(upstream, mapping.target));
  const recorded = state.overlays.find(item => item.source === mapping.source && item.target === mapping.target);
  if (!recorded || recorded.sha256 !== sha256(source) || !source.equals(installed)) throw new Error(`Overlay mismatch: ${mapping.target}`);
}
const metadata = readJson(path.join(upstream, 'apps/desktop/package.json'));
const profile = readJson(path.join(root, 'profiles/work.json'));
if (metadata.name !== profile.identity.packageName || metadata.main !== 'lib/ium-bootstrap.js') throw new Error('Desktop identity/bootstrap is not the Ium build');
if ('dshMandatoryUpdatePolicy' in metadata) throw new Error('Source Desktop manifest must not contain a mandatory-update policy');
const sourceInputSha256 = sha256(JSON.stringify({
  lock: sha256(fs.readFileSync(path.join(root, 'upstream.lock.json'))),
  patches: state.patches.map(({ path, sha256 }) => ({ path, sha256 })),
  overlays: state.overlays.map(({ source, target, sha256 }) => ({ source, target, sha256 })),
}));
const result = { schemaVersion: 1, upstreamCommit: pinned.commit, sourceInputSha256, trackedPatchedFiles: actual.size, overlays: overlays.files.length, sourceVerified: true, packagedDesktopVerified: false };
const destination = path.join(work, 'source-verification.json');
if (fs.existsSync(destination)) readJson(destination);
fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
