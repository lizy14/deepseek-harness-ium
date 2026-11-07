import fs from 'node:fs';
import path from 'node:path';

/** Resolve existing ancestors so a user-supplied symlink cannot alias the original application home. */
function canonicalPath(input) {
  const absolute = path.resolve(input);
  if (fs.existsSync(absolute)) return fs.realpathSync.native(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  return path.join(canonicalPath(parent), path.basename(absolute));
}
function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function selectedPath(override, fallback, forbidden) {
  if (override !== undefined && (!override.trim() || !path.isAbsolute(override))) throw new Error('Ium directory overrides must be nonempty absolute paths');
  const selected = canonicalPath(override === undefined ? fallback : override);
  for (const root of forbidden.map(canonicalPath)) if (inside(selected, root) || inside(root, selected)) throw new Error('Ium refuses to share or contain an original DSH data directory');
  return selected;
}
function writeOnce(file, content) {
  try { fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
}
function registryFromNpmFiles(homeDirectory, appDataDirectory, env) {
  const user = env.npm_config_userconfig ?? env.NPM_CONFIG_USERCONFIG ?? path.join(homeDirectory, '.npmrc');
  const prefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX ?? path.join(appDataDirectory, 'npm');
  const global = env.npm_config_globalconfig ?? env.NPM_CONFIG_GLOBALCONFIG ?? path.join(prefix, 'etc', 'npmrc');
  for (const file of [user, global]) {
    if (!path.isAbsolute(file)) throw new Error('Use an absolute npm configuration path or IUM_NPM_REGISTRY');
    let contents;
    try { contents = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    const matches = [...contents.matchAll(/^[\t ]*registry[\t ]*=[\t ]*(.*?)[\t ]*$/gmi)];
    if (matches.length > 0) return matches.at(-1)[1];
  }
  return undefined;
}
function registryUrl(value) {
  if (value === undefined || value === '') return null;
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Ium registry must be a valid HTTP(S) base URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Ium registry must be an HTTP(S) URL without credentials, query or fragment');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Plain HTTP registry is limited to loopback');
  return url.href.endsWith('/') ? url.href : url.href + '/';
}

/** Create isolated data roots and a first-launch, user-editable non-DeepSeek provider seed. */
export function prepareIumIdentity({ identity, initialModel, homeDirectory, appDataDirectory, env = process.env }) {
  const originalHome = path.join(homeDirectory, '.dsh');
  const originalUserData = path.join(appDataDirectory, '@deepseek-ai', 'dsh-desktop');
  const originalRoots = [originalHome, originalUserData];
  const harnessHome = selectedPath(env.IUM_DSH_HOME, path.join(homeDirectory, identity.homeDirectoryName), originalRoots);
  const userData = selectedPath(env.IUM_USER_DATA_DIR, path.join(appDataDirectory, identity.userDataDirectoryName), originalRoots);
  const inheritedRegistry = [env.IUM_NPM_REGISTRY, env.npm_config_registry, env.NPM_CONFIG_REGISTRY].find(value => typeof value === 'string' && value.trim() !== '');
  const registry = registryUrl(inheritedRegistry ?? registryFromNpmFiles(homeDirectory, appDataDirectory, env));
  const profile = selectedPath(undefined, path.join(harnessHome, 'profiles', 'desktop'), originalRoots);
  fs.mkdirSync(harnessHome, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  const model = env.IUM_DEFAULT_MODEL?.trim() || initialModel.model;
  const seed = [
    '# Ium first-launch defaults. Select a model available to your own account after sign-in.',
    '# This file is user-editable; the separate immutable work overlay owns network policy.',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: ${JSON.stringify(initialModel.provider)}`,
    `    model: ${JSON.stringify(model)}`,
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      github-copilot:',
    '        displayName: GitHub Copilot',
    '',
  ].join('\n');
  const profileSeeded = writeOnce(path.join(profile, 'cordis.patch.yml'), seed);
  writeOnce(path.join(harnessHome, 'AGENTS.md'), [
    '# Ium work-device network policy',
    '',
    'Do not contact deepseek.com, deepseeksvc.com, or their subdomains using application APIs, web/browser/MCP tools, shell commands, or external programs.',
    'Do not route through alternate hosts or proxies to evade this work-device policy. Use approved non-DeepSeek services instead.',
    'This guidance complements application transport enforcement; it is not an operating-system firewall for arbitrary external programs.',
    '',
  ].join('\n'));
  if (registry !== null) {
    env.npm_config_registry = registry;
    env.NPM_CONFIG_REGISTRY = registry;
    writeOnce(path.join(profile, '.npmrc'), `registry=${registry}\n`);
    writeOnce(path.join(harnessHome, '.env'), `npm_config_registry=${registry}\n`);
  }
  // Do not inherit the launching agent's managed session/home identity.
  env.DSH_HOME = harnessHome;
  env.DSH_PROFILE = 'desktop';
  env.DSH_PROFILE_DIR = profile;
  for (const key of ['DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) delete env[key];
  return { harnessHome, userData, profile, profileSeeded, registryConfigured: registry !== null };
}
