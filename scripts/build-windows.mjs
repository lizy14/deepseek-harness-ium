import fs from 'node:fs';
import path from 'node:path';
import { root, work, upstream, lock, readJson, run, pnpmEntry, buildEnvironment } from './lib.mjs';
import { beginAttempt, failAttempts, verifiedInput } from './attempt-receipt.mjs';

/** Build/preflight attempts invalidate both their own result and any previous package-verification PASS. */
export function buildWindows(args = process.argv.slice(2), options = {}) {
  const rootDirectory = options.rootDirectory ?? root;
  const workDirectory = options.workDirectory ?? work;
  const upstreamDirectory = options.upstreamDirectory ?? upstream;
  const execute = options.execute ?? run;
  const receipt = beginAttempt(path.join(workDirectory, 'build-result.json'), { kind: 'windows-build' });
  let packaged;
  try {
    packaged = beginAttempt(path.join(workDirectory, 'packaged-verification.json'), { kind: 'packaged-verification', id: receipt.id });
    const versionIndex = args.indexOf('--build-version');
    const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
    const mode = args.includes('--check') ? 'preflight' : args.includes('--dir') ? 'directory' : 'installer';
    receipt.update({ requestedBuildVersion: version ?? null, mode, signed: false, uploaded: false });
    packaged.update({ requestedBuildVersion: version ?? null });
    const pinned = (options.readLock ?? lock)();
    receipt.update({ upstreamCommit: pinned.commit });
    if ((options.platform ?? process.platform) !== 'win32' || (options.architecture ?? process.arch) !== 'x64') throw new Error('This recipe currently supports Windows x64 only');
    if (process.versions.node !== pinned.toolchain.node) throw new Error(`Packaging requires pinned Node ${pinned.toolchain.node}; current ${process.versions.node}`);
    if (!version || version === 'auto' || !version.startsWith(pinned.version + '.') || !/^[0-9A-Za-z.-]+$/.test(version)) throw new Error(`Pass an explicit --build-version beginning ${pinned.version}. (never auto)`);
    if (args.filter(arg => arg === '--build-version').length !== 1) throw new Error('Exactly one build version is required');
    for (const arg of args) if (!['--build-version', version, '--check', '--dir'].includes(arg)) throw new Error(`Unknown build option: ${arg}`);
    execute(process.execPath, [path.join(rootDirectory, 'scripts/verify.mjs')]);
    const input = verifiedInput(path.join(workDirectory, 'source-verification.json'));
    receipt.update({ sourceInputSha256: input.sourceInputSha256 });
    packaged.update({ sourceInputSha256: input.sourceInputSha256, upstreamCommit: input.upstreamCommit });
    const profile = readJson(path.join(rootDirectory, 'profiles/work.json'));
    const config = path.join(upstreamDirectory, 'apps/desktop/.env.windows');
    const content = `# Generated Ium unsigned work-build identity; no update origin or signing credentials.\nDSH_DESKTOP_APP_ID=${profile.identity.appId}\n`;
    if (fs.existsSync(config)) {
      if (fs.readFileSync(config, 'utf8') !== content) throw new Error('Existing desktop build configuration differs; refusing to overwrite it');
    } else fs.writeFileSync(config, content, { flag: 'wx' });
    const registry = process.env.IUM_NPM_REGISTRY ?? process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
    const env = (options.makeEnvironment ?? buildEnvironment)({ NPM_CONFIG_CACHE: path.join(workDirectory, 'npm-cache'), ...(registry ? { DSH_DESKTOP_NPM_REGISTRY: registry, npm_config_registry: registry } : {}) });
    const command = [(options.resolvePnpm ?? pnpmEntry)(), '--dir', 'apps/desktop', 'run', 'package:win:x64:unsigned', '--build-version', version];
    if (args.includes('--check')) command.push('--check');
    if (args.includes('--dir')) command.push('--dir');
    execute(process.execPath, command, { cwd: upstreamDirectory, env });
    let complete;
    if (mode === 'preflight') {
      packaged.notRun('Preflight only: no packaged artifact was verified in this attempt');
      complete = receipt.pass({ artifactHashes: {}, artifactHashScope: 'none-preflight', staticPackagedChecksPassed: false }, { requireArtifacts: false });
    } else {
      execute(process.execPath, [path.join(rootDirectory, 'scripts/verify-packaged.mjs'), '--build-version', version, '--attempt-id', receipt.id, '--source-input-sha256', input.sourceInputSha256], { env });
      const verified = readJson(path.join(workDirectory, 'packaged-verification.json'));
      if (verified.result !== 'PASS' || verified.attemptId !== receipt.id || verified.sourceInputSha256 !== input.sourceInputSha256 || verified.requestedBuildVersion !== version || verified.version !== version) throw new Error('Package verification receipt does not match this build attempt');
      complete = receipt.pass({ artifactHashes: verified.artifactHashes, staticPackagedChecksPassed: true, packageVerificationAttemptId: verified.attemptId });
    }
    if (!options.quiet) console.log(JSON.stringify(complete, null, 2));
    return complete;
  } catch (error) { return failAttempts(error, receipt, packaged); }
}

if (import.meta.main) buildWindows();
