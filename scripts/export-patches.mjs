import fs from 'node:fs';
import path from 'node:path';
import { root, upstream, readJson, within, capture, verifyUpstream } from './lib.mjs';

verifyUpstream();
const groups = readJson(path.join(root, 'patches/groups.json'));
const series = readJson(path.join(root, 'patches/series.json'));
if (groups.schemaVersion !== 1 || JSON.stringify(groups.groups.map(group => group.file)) !== JSON.stringify(series.patches)) throw new Error('Patch groups and series do not agree');
const owned = new Set();
for (const group of groups.groups) for (const file of group.paths) {
  within(upstream, file);
  if (owned.has(file)) throw new Error(`Patch groups overlap: ${file}`);
  owned.add(file);
}
const changed = capture('git', ['diff', '--name-only', '--'], { cwd: upstream }).split(/\r?\n/).filter(Boolean);
for (const file of changed) if (!owned.has(file)) throw new Error(`Unreviewed tracked change outside patch groups: ${file}`);
for (const group of groups.groups) {
  const patch = capture('git', ['-c', 'diff.algorithm=myers', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', '--unified=3', '--', ...group.paths], { cwd: upstream, trim: false });
  if (!patch.startsWith('diff --git ')) throw new Error(`Empty patch group: ${group.file}`);
  const file = within(path.join(root, 'patches'), group.file);
  if (fs.existsSync(file)) fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, patch);
}
console.log(JSON.stringify({ exported: groups.groups.map(group => group.file), trackedFiles: changed.length }, null, 2));
