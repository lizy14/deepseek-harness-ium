import fs from 'node:fs';
import path from 'node:path';
import { root, work, upstream, readJson, sha256 } from './lib.mjs';
import { attemptId, beginAttempt, failAttempts, verifiedInput } from './attempt-receipt.mjs';

/** Tokenize the pinned JavaScript output without evaluating imports, templates, or package code. */
function javascriptTokens(code) {
  const tokens = [];
  let at = code.startsWith('#!') ? code.indexOf('\n') : 0;
  if (at < 0) return tokens;
  const push = (kind, value) => tokens.push({ kind, value });
  const regexStart = () => tokens.length === 0 || ['(', '[', '{', ',', ';', ':', '=', '=>', '!', '&&', '||', '??', '?', 'return', 'throw', 'case'].includes(tokens.at(-1).value);
  function quoted(quote) {
    const start = ++at;
    while (at < code.length) {
      if (code[at] === '\\') { at += 2; continue; }
      if (code[at] === quote) { push('string', code.slice(start, at++)); return; }
      at++;
    }
    throw new Error('Unterminated string in packaged JavaScript');
  }
  function template() {
    at++;
    push('literal', 'template');
    while (at < code.length) {
      if (code[at] === '\\') { at += 2; continue; }
      if (code[at] === '`') { at++; push('literal', 'template'); return; }
      if (code[at] === '$' && code[at + 1] === '{') {
        at += 2; push('punctuation', '{'); scan(true);
      } else at++;
    }
    throw new Error('Unterminated template in packaged JavaScript');
  }
  function regularExpression() {
    at++;
    let inClass = false;
    while (at < code.length) {
      const character = code[at++];
      if (character === '\\') { at++; continue; }
      if (character === '[') inClass = true;
      if (character === ']') inClass = false;
      if (character === '/' && !inClass) {
        while (/[a-z]/i.test(code[at] ?? '') && at < code.length) at++;
        push('literal', 'regexp'); return;
      }
    }
    throw new Error('Unterminated regular expression in packaged JavaScript');
  }
  function scan(interpolation = false) {
    let braces = 0;
    while (at < code.length) {
      const character = code[at];
      if (/\s/.test(character)) { at++; continue; }
      if (code.startsWith('//', at)) { const end = code.indexOf('\n', at + 2); at = end < 0 ? code.length : end; continue; }
      if (code.startsWith('/*', at)) {
        const end = code.indexOf('*/', at + 2);
        if (end < 0) throw new Error('Unterminated comment in packaged JavaScript');
        at = end + 2; continue;
      }
      if (character === '"' || character === "'") { quoted(character); continue; }
      if (character === '`') { template(); continue; }
      if (character === '/' && regexStart()) { regularExpression(); continue; }
      const word = /^[A-Za-z_$][\w$]*/.exec(code.slice(at));
      if (word) { push('word', word[0]); at += word[0].length; continue; }
      if (/\d/.test(character)) {
        const number = /^[\w.]+/.exec(code.slice(at))[0];
        push('literal', number); at += number.length; continue;
      }
      const operator = /^(?:\.\.\.|===|!==|=>|\?\?|\?\.|&&|\|\||==|!=|<=|>=|\+\+|--)/.exec(code.slice(at))?.[0] ?? character;
      push('punctuation', operator); at += operator.length;
      if (operator === '{') braces++;
      if (operator === '}') {
        if (interpolation && braces === 0) return;
        braces--;
      }
    }
    if (interpolation) throw new Error('Unterminated template interpolation in packaged JavaScript');
  }
  scan();
  return tokens;
}

function literalRelativeImports(tokens) {
  const imports = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'word') continue;
    let source;
    if (token.value === 'from') source = tokens[index + 1];
    else if (token.value === 'import' && !['.', '?.'].includes(tokens[index - 1]?.value)) {
      if (tokens[index + 1]?.value === '(') {
        if ([')', ','].includes(tokens[index + 3]?.value)) source = tokens[index + 2];
      } else source = tokens[index + 1];
    }
    if (source?.kind === 'string' && source.value.startsWith('.')) imports.push(source.value);
  }
  return imports;
}

function matchesTokens(tokens, expected, start = 0) {
  return expected.every((token, index) => token.kind === tokens[start + index]?.kind && token.value === tokens[start + index]?.value);
}
function containsTokens(tokens, text) {
  const expected = javascriptTokens(text);
  return tokens.some((_token, index) => matchesTokens(tokens, expected, index));
}
function closingToken(tokens, start, opening, closing) {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind !== 'punctuation') continue;
    if (tokens[index].value === opening) depth++;
    if (tokens[index].value === closing && --depth === 0) return index;
  }
  throw new Error('Unbalanced packaged CLI function');
}
function declaredFunctions(modules, name) {
  const definitions = [];
  for (const [file, tokens] of modules) {
    for (let index = 0; index < tokens.length; index++) {
      if (!matchesTokens(tokens, javascriptTokens(`function ${name} (`), index)) continue;
      const end = closingToken(tokens, index + 2, '(', ')');
      if (tokens[end + 1]?.value !== '{') throw new Error(`Unsupported packaged CLI function: ${name}`);
      const bodyEnd = closingToken(tokens, end + 1, '{', '}');
      definitions.push({ file, parameters: tokens.slice(index + 3, end), body: tokens.slice(end + 2, bodyEnd) });
    }
  }
  return definitions;
}
function topLevelSequence(tokens, text) {
  const expected = javascriptTokens(text);
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (depth === 0 && matchesTokens(tokens, expected, index)) return index;
    if (tokens[index].kind === 'punctuation' && tokens[index].value === '{') depth++;
    if (tokens[index].kind === 'punctuation' && tokens[index].value === '}') depth--;
  }
  return -1;
}

/** Check each implementation separately: a new bin cannot supply the evidence for an old dump chunk. */
function verifyCliDeployment(modules, entry) {
  const role = name => {
    const definitions = declaredFunctions(modules, name);
    if (definitions.length !== 1) throw new Error(`Packaged CLI must contain one ${name} implementation`);
    return definitions[0];
  };
  const requireSequence = (definition, text, label) => {
    if (!containsTokens(definition.body, text)) throw new Error(`Packaged CLI ${label} lacks final deployment support: ${definition.file}`);
  };
  const requireParameters = (definition, text, label) => {
    const expected = javascriptTokens(text);
    if (definition.parameters.length !== expected.length || !matchesTokens(definition.parameters, expected)) {
      throw new Error(`Packaged CLI ${label} lacks deployment parameters: ${definition.file}`);
    }
  };
  const bin = role('runCli');
  if (bin.file !== entry) throw new Error('Packaged CLI runCli is not declared by its public entry');
  requireSequence(bin, 'deploymentPatchFiles = []', 'runCli');
  requireSequence(bin, 'patchFiles: [...invocation.patches, ...deploymentPatchFiles]', 'profile dispatch');
  requireSequence(bin, 'runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches, invocation.fromDefaultProfile, deploymentPatchFiles)', 'dump dispatch');
  requireSequence(bin, 'runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile, deploymentPatchFiles)', 'schema dispatch');
  const dump = role('runDumpConfig');
  requireParameters(dump, 'profile, defaultOnly, patches, fromDefaultProfile, deploymentPatchFiles = []', 'runDumpConfig');
  requireSequence(dump, 'prepareProfile(profile, !defaultOnly, fromDefaultProfile)', 'default dump');
  requireSequence(dump, 'collectConfigDumpLayers(loaded, defaultOnly, patches, deploymentPatchFiles)', 'runDumpConfig');
  const schema = role('runDumpConfigSchema');
  requireParameters(schema, 'profile, patches, fromDefaultProfile, deploymentPatchFiles = []', 'runDumpConfigSchema');
  requireSequence(schema, 'collectConfigDumpLayers(loaded, false, patches, deploymentPatchFiles)', 'runDumpConfigSchema');
  requireSequence(schema, 'generateConfigSchema(loaded, layers.map(', 'schema generation');
  const composer = role('collectConfigDumpLayers');
  requireParameters(composer, 'loaded, defaultOnly, patches, deploymentPatchFiles = []', 'collectConfigDumpLayers');
  const user = topLevelSequence(composer.body, 'if (!defaultOnly) {');
  const deployment = topLevelSequence(composer.body, 'for (const file of deploymentPatchFiles) {');
  if (user < 0 || deployment < 0) throw new Error('Packaged CLI default composer does not retain deployment layers');
  const userEnd = closingToken(composer.body, user + 5, '{', '}');
  const loopEnd = closingToken(composer.body, deployment + 7, '{', '}');
  const tail = javascriptTokens('return layers;');
  if (deployment !== userEnd + 1 || composer.body.length - loopEnd - 1 !== tail.length || !matchesTokens(composer.body, tail, loopEnd + 1)) {
    throw new Error('Packaged CLI deployment loop must follow user layers and precede the final return');
  }
  const loop = { file: composer.file, body: composer.body.slice(deployment + 8, loopEnd) };
  requireSequence(loop, 'resolve(file)', 'deployment path resolution');
  requireSequence(loop, 'layers.push(', 'deployment layer append');
  requireSequence(loop, 'loadOverlayPatches(NAME, absolute)', 'deployment layer loading');
}

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
    const inspectRelativeChunks = (name, code, libraryRoot = 'lib/', modules = new Map()) => {
      if (modules.has(name)) return modules;
      const tokens = javascriptTokens(code);
      modules.set(name, tokens);
      chunks.add(name);
      for (const specifier of literalRelativeImports(tokens)) {
        const relative = decodeURIComponent(specifier.split(/[?#]/, 1)[0]);
        if (specifier.includes('\\') || relative.includes('\\') || relative.includes('\0')) throw new Error('Unsupported relative chunk spelling');
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), relative));
        if (!target.startsWith(libraryRoot)) throw new Error(`Relative chunk escaped the packaged library: ${name}`);
        const bytes = readEntry(target);
        if (/\.(?:mjs|js|cjs)$/.test(target)) inspectRelativeChunks(target, bytes.toString('utf8'), libraryRoot, modules);
      }
      return modules;
    };
    packageInfo = JSON.parse(readEntry('package.json'));
    if (packageInfo.version !== requestedBuildVersion) throw new Error(`Packaged version does not equal requested build version ${requestedBuildVersion}`);
    if (packageInfo.name !== profile.identity.packageName || packageInfo.main !== 'lib/ium-bootstrap.js') throw new Error('Packaged identity or bootstrap is not Ium');
    if (packageInfo.dshDesktopAppId !== profile.identity.appId) throw new Error('Packaged application ID differs from work policy');
    if ('dshMandatoryUpdatePolicy' in packageInfo) throw new Error('Packaged mandatory-update metadata is present');
    const bootstrap = readEntry('lib/ium-bootstrap.js').toString('utf8');
    const preload = readEntry('lib/ium-node-preload.js').toString('utf8');
    const cliBootstrap = readEntry('lib/ium-cli-bootstrap.js').toString('utf8');
    const cliCarrier = readEntry('dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js').toString('utf8');
    const policy = readEntry('lib/ium-network-policy.js').toString('utf8');
    for (const value of ['ium-network-policy.js', 'data:,ium-policy-initialize', 'main.js']) if (!bootstrap.includes(value)) throw new Error(`Bootstrap is missing ${value}`);
    if (/from\s*["'](?:electron-updater|ws)["']/.test(bootstrap)) throw new Error('Application dependencies load statically before network policy');
    if (!preload.includes('ium-network-policy.js') || !preload.includes('data:,ium-policy-initialize')) throw new Error('Host preload is incomplete');
    for (const value of ['deepseek.com', 'deepseeksvc.com', 'ERR_IUM_NETWORK_BLOCKED']) if (!policy.includes(value)) throw new Error(`Policy artifact is missing ${value}`);
    inspectRelativeChunks('lib/ium-bootstrap.js', bootstrap);
    inspectRelativeChunks('lib/ium-node-preload.js', preload);
    for (const value of ['ium-node-preload.js', 'dsh-desktop-host/lib/cli.js', 'ium-work.cordis.yml', 'deploymentPatchFiles', 'networkPreload', 'DSH_PROFILE_DIR']) {
      if (!cliBootstrap.includes(value)) throw new Error(`CLI bootstrap is missing ${value}`);
    }
    if (/(?:from\s*|import\s*)["'](?:electron(?:\/[^"']*)?|@deepseek-ai\/[^"']+)["']/.test(cliBootstrap)) throw new Error('CLI dependencies load statically before network policy');
    for (const value of ['deploymentPatchFiles', 'networkPreload', '--import']) if (!cliCarrier.includes(value)) throw new Error(`CLI carrier is missing ${value}`);
    inspectRelativeChunks('lib/ium-cli-bootstrap.js', cliBootstrap);
    const cliRoot = 'dsh/node_modules/@deepseek-ai/dsh/lib/';
    const cliEntry = cliRoot + 'bin.js';
    const cliModules = inspectRelativeChunks(cliEntry, readEntry(cliEntry).toString('utf8'), cliRoot);
    verifyCliDeployment(cliModules, cliEntry);
    const commandRelative = 'resources/runtime/cli/bin/dsh.cmd';
    const commandBytes = fs.readFileSync(path.join(directory, commandRelative));
    const command = commandBytes.toString('utf8').replaceAll('\r\n', '\n');
    const expectedExecutable = `%~dp0..\\..\\..\\..\\${profile.identity.productName}.exe`;
    const expectedCommand = [
      '@echo off', 'setlocal DisableDelayedExpansion', 'set "ELECTRON_RUN_AS_NODE=1"',
      `"${expectedExecutable}" --expose-internals "%~dp0..\\..\\..\\app.asar\\lib\\ium-cli-bootstrap.js" %*`,
      'exit /b %errorlevel%', '',
    ].join('\n');
    if (command !== expectedCommand) throw new Error('Packaged CLI launcher does not use the complete guarded Ium invocation');
    entryHashes[commandRelative] = sha256(commandBytes);
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
