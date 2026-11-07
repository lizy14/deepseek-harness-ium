import fs from 'node:fs';
import path from 'node:path';
import { root, work, upstream, readJson, sha256 } from './lib.mjs';
import { attemptId, beginAttempt, failAttempts, verifiedInput } from './attempt-receipt.mjs';

/** Inspect a bounded synthetic or real ASAR without executing any packaged code. */
export function inspectPackagedArtifact({ directory, profile, deploymentBytes, requestedBuildVersion }) {
  if (typeof requestedBuildVersion !== 'string' || !requestedBuildVersion || requestedBuildVersion === 'auto' || !/^[0-9A-Za-z.-]+$/.test(requestedBuildVersion)) throw new Error('An explicit requested build version is required');
  const resources = path.join(directory, 'resources');
  const archive = path.join(resources, 'app.asar');
  const executable = path.join(directory, profile.identity.productName + '.exe');
  if (!fs.existsSync(executable) || !fs.existsSync(archive)) throw new Error('Expected Ium Windows directory artifact is missing');
  if (fs.existsSync(path.join(resources, 'app-update.yml'))) throw new Error('Unexpected packaged automatic-update feed');
  const descriptor = fs.openSync(archive, 'r');
  let packageInfo;
  const entryHashes = {};
  const chunks = new Set();
  try {
    const readExact = (size, offset) => {
      const data = Buffer.alloc(size);
      if (fs.readSync(descriptor, data, 0, size, offset) !== size) throw new Error('Truncated ASAR input');
      return data;
    };
    const prefix = readExact(16, 0);
    const headerSize = prefix.readUInt32LE(12); const dataOffset = 8 + prefix.readUInt32LE(4);
    const fileSize = fs.fstatSync(descriptor).size;
    if (headerSize > 64 * 1024 * 1024 || dataOffset < 16 + headerSize || dataOffset > fileSize) throw new Error('Invalid ASAR header bounds');
    const tree = JSON.parse(readExact(headerSize, 16).toString('utf8'));
    const readEntry = name => {
      let entry = tree;
      for (const part of name.split('/')) entry = entry?.files?.[part];
      if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Missing packed entry: ${name}`);
      const offset = dataOffset + Number(entry.offset);
      if (!Number.isSafeInteger(offset) || offset < dataOffset || offset + entry.size > fileSize) throw new Error(`Invalid entry bounds: ${name}`);
      const data = readExact(entry.size, offset);
      const digest = sha256(data);
      if (entry.integrity?.algorithm !== 'SHA256' || entry.integrity.hash !== digest) throw new Error(`Entry integrity mismatch: ${name}`);
      entryHashes['asar:' + name] = digest;
      return data;
    };
    const inspectRelativeChunks = (name, code) => {
      if (chunks.has(name)) return;
      chunks.add(name);
      // Compiled Ium entries use literal ESM imports/re-exports; dynamic app loading stays separate.
      const imports = /\b(?:import|export)\s*(?:[^;'\"]*?\bfrom\s*)?(['"])(\.[^'"]+)\1/g;
      for (const match of code.matchAll(imports)) {
        const specifier = match[2];
        if (specifier.includes('\\')) throw new Error('Unsupported relative chunk spelling');
        const relative = decodeURIComponent(specifier.split(/[?#]/, 1)[0]);
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), relative));
        if (!target.startsWith('lib/')) throw new Error('Relative chunk escaped the packaged library');
        const bytes = readEntry(target);
        if (/\.(?:mjs|js|cjs)$/.test(target)) inspectRelativeChunks(target, bytes.toString('utf8'));
      }
    };
    packageInfo = JSON.parse(readEntry('package.json'));
    if (packageInfo.version !== requestedBuildVersion) throw new Error(`Packaged version does not equal requested build version ${requestedBuildVersion}`);
    if (packageInfo.name !== profile.identity.packageName || packageInfo.main !== 'lib/ium-bootstrap.js') throw new Error('Packaged identity or bootstrap is not Ium');
    if (packageInfo.dshDesktopAppId !== profile.identity.appId) throw new Error('Packaged application ID differs from work policy');
    if ('dshMandatoryUpdatePolicy' in packageInfo) throw new Error('Packaged mandatory-update metadata is present');
    const bootstrap = readEntry('lib/ium-bootstrap.js').toString('utf8');
    const preload = readEntry('lib/ium-node-preload.js').toString('utf8');
    const policy = readEntry('lib/ium-network-policy.js').toString('utf8');
    for (const value of ['ium-network-policy.js', 'data:,ium-policy-initialize', 'main.js']) if (!bootstrap.includes(value)) throw new Error(`Bootstrap is missing ${value}`);
    if (/from\s*["'](?:electron-updater|ws)["']/.test(bootstrap)) throw new Error('Application dependencies load statically before network policy');
    if (!preload.includes('ium-network-policy.js') || !preload.includes('data:,ium-policy-initialize')) throw new Error('Host preload is incomplete');
    for (const value of ['deepseek.com', 'deepseeksvc.com', 'ERR_IUM_NETWORK_BLOCKED']) if (!policy.includes(value)) throw new Error(`Policy artifact is missing ${value}`);
    inspectRelativeChunks('lib/ium-bootstrap.js', bootstrap);
    inspectRelativeChunks('lib/ium-node-preload.js', preload);
    const dispatcher = JSON.parse(readEntry('node_modules/undici/package.json'));
    if (dispatcher.version !== '7.29.1') throw new Error('Unexpected packaged dispatcher version');
    const deployment = readEntry('dsh/node_modules/@deepseek-ai/dsh-desktop-host/ium-work.cordis.yml');
    if (!deployment.equals(deploymentBytes)) throw new Error('Packaged Host overlay differs from reviewed policy');
  } finally { fs.closeSync(descriptor); }
  const archiveSha256 = sha256(fs.readFileSync(archive));
  const executableSha256 = sha256(fs.readFileSync(executable));
  return {
    directory, version: packageInfo.version, name: packageInfo.name, archiveSha256, executableSha256,
    artifactHashes: { 'resources/app.asar': archiveSha256, [path.basename(executable)]: executableSha256, ...entryHashes },
    checkedRelativeModules: [...chunks].sort(), staticPackagedChecksPassed: true, signed: false, nativeDesktopAcceptancePassed: false,
    note: 'Upstream runtime smoke and separate native policy/Desktop acceptance records are required; static inspection alone is not a release qualification.',
  };
}

/** Legacy optional-directory calls remain valid; an omitted version uses release-plan, never artifact metadata. */
export function verifyPackaged(args = process.argv.slice(2), options = {}) {
  const rootDirectory = options.rootDirectory ?? root;
  const workDirectory = options.workDirectory ?? work;
  const upstreamDirectory = options.upstreamDirectory ?? upstream;
  const suppliedId = args[args.indexOf('--attempt-id') + 1];
  const rawId = args.includes('--attempt-id') ? suppliedId : undefined;
  const receipt = beginAttempt(path.join(workDirectory, 'packaged-verification.json'), { kind: 'packaged-verification', id: attemptId(rawId) });
  try {
    let directory, version, expectedDigest;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (['--build-version', '--attempt-id', '--source-input-sha256'].includes(arg)) {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        if (arg === '--build-version') { if (version !== undefined) throw new Error('Duplicate build version'); version = value; }
        if (arg === '--source-input-sha256') { if (expectedDigest !== undefined) throw new Error('Duplicate source input digest'); expectedDigest = value; }
        if (arg === '--attempt-id' && value !== receipt.id) throw new Error('Invalid attempt ID');
      } else {
        if (arg.startsWith('--') || directory !== undefined) throw new Error('Unexpected packaged verification argument');
        directory = path.resolve(arg);
      }
    }
    version ??= readJson(path.join(rootDirectory, 'release-plan.json')).version;
    receipt.update({ requestedBuildVersion: version });
    const input = verifiedInput(path.join(workDirectory, 'source-verification.json'), expectedDigest);
    receipt.update({ sourceInputSha256: input.sourceInputSha256, upstreamCommit: input.upstreamCommit });
    directory ??= path.join(upstreamDirectory, 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked');
    const result = inspectPackagedArtifact({
      directory, requestedBuildVersion: version,
      profile: readJson(path.join(rootDirectory, 'profiles/work.json')),
      deploymentBytes: fs.readFileSync(path.join(rootDirectory, 'profiles/work.cordis.yml')),
    });
    const complete = receipt.pass(result);
    if (!options.quiet) console.log(JSON.stringify(complete, null, 2));
    return complete;
  } catch (error) { return failAttempts(error, receipt); }
}

if (import.meta.main) verifyPackaged();
