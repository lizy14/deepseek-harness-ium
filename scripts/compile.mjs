import fs from 'node:fs';
import path from 'node:path';
import { root, work, upstream, lock, run, pnpmEntry, buildEnvironment } from './lib.mjs';
import { beginAttempt, failAttempts, hashFile, verifiedInput } from './attempt-receipt.mjs';

/** Compile both scopes; command injection is used only by offline fixture tests. */
export function compileArtifacts(options = {}) {
  const rootDirectory = options.rootDirectory ?? root;
  const workDirectory = options.workDirectory ?? work;
  const upstreamDirectory = options.upstreamDirectory ?? upstream;
  const execute = options.execute ?? run;
  const receipt = beginAttempt(path.join(workDirectory, 'compile-result.json'), { kind: 'compile' });
  try {
    const pinned = (options.readLock ?? lock)();
    const requestedBuildVersion = options.requestedBuildVersion ?? pinned.version;
    receipt.update({ upstreamCommit: pinned.commit, requestedBuildVersion, node: process.versions.node, scopes: ['artifacts', 'check'], packagedDesktopVerified: false });
    if (process.versions.node !== pinned.toolchain.node) throw new Error(`Use pinned Node ${pinned.toolchain.node} for artifact compilation`);
    // compile --profile local uses the pinned product version, not a packaging version override.
    if (requestedBuildVersion !== pinned.version) throw new Error('Artifact compilation requires the pinned product version');
    execute(process.execPath, [path.join(rootDirectory, 'scripts/verify.mjs')]);
    const input = verifiedInput(path.join(workDirectory, 'source-verification.json'));
    receipt.update({ sourceInputSha256: input.sourceInputSha256 });
    const env = (options.makeEnvironment ?? buildEnvironment)({ CI: 'true', NPM_CONFIG_CACHE: path.join(workDirectory, 'npm-cache') });
    const entry = (options.resolvePnpm ?? pnpmEntry)();
    execute(process.execPath, [entry, 'run', 'build:artifacts', '--profile', 'local'], { cwd: upstreamDirectory, env });
    execute(process.execPath, [entry, 'run', 'build:check'], { cwd: upstreamDirectory, env });
    const directory = path.join(upstreamDirectory, 'apps/desktop/lib');
    const names = new Set(['main.js', 'ium-bootstrap.js', 'ium-cli-bootstrap.js', 'ium-node-preload.js', 'ium-network-policy.js']);
    for (const name of fs.readdirSync(directory)) if (/^ium-.*\.js$/.test(name)) names.add(name);
    const artifactHashes = Object.fromEntries([...names].sort().map(name => ['apps/desktop/lib/' + name, hashFile(path.join(directory, name))]));
    return receipt.pass({ artifactHashes, artifactHashScope: 'Desktop compiled entries and Ium chunks' });
  } catch (error) { return failAttempts(error, receipt); }
}

if (import.meta.main) compileArtifacts();
