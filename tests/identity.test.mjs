import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareIumIdentity } from '../overlays/desktop/ium-identity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const policy = JSON.parse(fs.readFileSync(path.join(root, 'profiles/work.json'), 'utf8'));
const fixtures = path.join(root, '.work', 'identity-tests');
fs.mkdirSync(fixtures, { recursive: true });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fixtures, 'case-'));
  const homeDirectory = path.join(directory, 'home');
  const appDataDirectory = path.join(directory, 'app-data');
  fs.mkdirSync(path.join(homeDirectory, '.dsh'), { recursive: true });
  fs.mkdirSync(path.join(appDataDirectory, '@deepseek-ai', 'dsh-desktop'), { recursive: true });
  fs.writeFileSync(path.join(homeDirectory, '.dsh', 'do-not-copy.txt'), 'original-data');
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== fs.realpathSync(fixtures) || !path.basename(resolved).startsWith('case-')) throw new Error('Refusing unexpected test cleanup path');
    fs.rmSync(resolved, { recursive: true });
  });
  return { ...policy, directory, homeDirectory, appDataDirectory };
}

test('creates separate homes and does not inherit the original managed session', t => {
  const input = fixture(t);
  const env = { DSH_HOME: path.join(input.homeDirectory, '.dsh'), DSH_SESSION_ID: 'old-session', DSH_WEB_URL: 'http://127.0.0.1:1', DSH_SHELL: '1' };
  const result = prepareIumIdentity({ ...input, env });
  assert.equal(result.harnessHome, path.join(input.homeDirectory, '.dsh-ium'));
  assert.equal(result.userData, path.join(input.appDataDirectory, '@lizy14', 'dsh-desktop-ium'));
  assert.equal(env.DSH_HOME, result.harnessHome);
  assert.equal(env.DSH_PROFILE, 'desktop');
  assert.equal(env.DSH_SESSION_ID, undefined);
  assert.equal(env.DSH_WEB_URL, undefined);
  assert.equal(env.DSH_SHELL, undefined);
  assert.equal(fs.existsSync(path.join(result.harnessHome, 'do-not-copy.txt')), false);
  assert.equal(fs.readFileSync(path.join(input.homeDirectory, '.dsh', 'do-not-copy.txt'), 'utf8'), 'original-data');
  const seed = fs.readFileSync(path.join(result.profile, 'cordis.patch.yml'), 'utf8');
  assert.match(seed, /provider: "github-copilot"/);
  assert.doesNotMatch(seed, /provider: deepseek/);
  const guidance = fs.readFileSync(path.join(result.harnessHome, 'AGENTS.md'), 'utf8');
  assert.match(guidance, /deepseek\.com/);
  assert.match(guidance, /not an operating-system firewall/);
});

test('preserves subsequent user model settings and existing private npm config', t => {
  const input = fixture(t);
  const env = { IUM_NPM_REGISTRY: 'https://packages.example.test/npm' };
  const first = prepareIumIdentity({ ...input, env });
  const file = path.join(first.profile, 'cordis.patch.yml');
  fs.writeFileSync(file, '# user configuration\n');
  fs.writeFileSync(path.join(first.profile, '.npmrc'), 'registry=https://existing.example.test/\n');
  const second = prepareIumIdentity({ ...input, env: { ...env, IUM_DEFAULT_MODEL: 'another-model' } });
  assert.equal(second.profileSeeded, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '# user configuration\n');
  assert.equal(fs.readFileSync(path.join(first.profile, '.npmrc'), 'utf8'), 'registry=https://existing.example.test/\n');
  assert.equal(env.npm_config_registry, 'https://packages.example.test/npm/');
  assert.equal(env.NPM_CONFIG_REGISTRY, env.npm_config_registry);
});

test('adopts only the user npm registry and never copies its authentication fields', t => {
  const input = fixture(t);
  const npmrc = 'registry=https://packages.example.test/npm/\n//packages.example.test/:_authToken=fixture-not-for-copy\n';
  fs.writeFileSync(path.join(input.homeDirectory, '.npmrc'), npmrc);
  const env = {};
  const result = prepareIumIdentity({ ...input, env });
  assert.equal(env.npm_config_registry, 'https://packages.example.test/npm/');
  assert.equal(fs.readFileSync(path.join(result.profile, '.npmrc'), 'utf8'), 'registry=https://packages.example.test/npm/\n');
  assert.equal(fs.readFileSync(path.join(result.harnessHome, '.env'), 'utf8'), 'npm_config_registry=https://packages.example.test/npm/\n');
  assert.equal(fs.readFileSync(path.join(input.homeDirectory, '.npmrc'), 'utf8'), npmrc);
});

test('explicit registry wins without reading an unrelated npm config file', t => {
  const input = fixture(t);
  const result = prepareIumIdentity({ ...input, env: { IUM_NPM_REGISTRY: 'https://approved.example.test/', NPM_CONFIG_USERCONFIG: 'ambiguous-relative-file' } });
  assert.equal(result.registryConfigured, true);
});

test('rejects original DSH homes, their ancestors and relative overrides', t => {
  const input = fixture(t);
  for (const value of [path.join(input.homeDirectory, '.dsh'), input.homeDirectory, '.dsh-other']) {
    assert.throws(() => prepareIumIdentity({ ...input, env: { IUM_DSH_HOME: value } }));
  }
  assert.throws(() => prepareIumIdentity({ ...input, env: { IUM_USER_DATA_DIR: path.join(input.appDataDirectory, '@deepseek-ai', 'dsh-desktop') } }));
});

test('rejects a Harness home override into original Desktop user data', t => {
  const input = fixture(t);
  const originalUserData = path.join(input.appDataDirectory, '@deepseek-ai', 'dsh-desktop');
  const alias = path.join(input.directory, 'desktop-data-alias');
  fs.symlinkSync(originalUserData, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const value of [originalUserData, path.dirname(originalUserData), path.join(originalUserData, 'child'), alias]) {
    assert.throws(() => prepareIumIdentity({ ...input, env: { IUM_DSH_HOME: value } }), /refuses to share/);
  }
  assert.deepEqual(fs.readdirSync(originalUserData), []);
  assert.equal(fs.existsSync(path.join(input.homeDirectory, '.dsh-ium')), false);
});

test('rejects an Electron user-data override into the original Harness home', t => {
  const input = fixture(t);
  const originalHome = path.join(input.homeDirectory, '.dsh');
  const alias = path.join(input.directory, 'harness-home-alias');
  fs.symlinkSync(originalHome, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const value of [originalHome, path.dirname(originalHome), path.join(originalHome, 'child'), alias]) {
    assert.throws(() => prepareIumIdentity({ ...input, env: { IUM_USER_DATA_DIR: value } }), /refuses to share/);
  }
  assert.deepEqual(fs.readdirSync(originalHome), ['do-not-copy.txt']);
  assert.equal(fs.existsSync(path.join(input.homeDirectory, '.dsh-ium')), false);
});

test('rejects a home alias that resolves to original DSH data', t => {
  const input = fixture(t);
  const alias = path.join(input.homeDirectory, 'alias');
  fs.symlinkSync(path.join(input.homeDirectory, '.dsh'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareIumIdentity({ ...input, env: { IUM_DSH_HOME: alias } }), /refuses to share/);
});

test('rejects a profile subtree alias into either original data root', t => {
  for (const kind of ['harness', 'desktop']) {
    const input = fixture(t);
    const originalRoot = kind === 'harness'
      ? path.join(input.homeDirectory, '.dsh')
      : path.join(input.appDataDirectory, '@deepseek-ai', 'dsh-desktop');
    const originalProfile = path.join(originalRoot, 'profiles', 'desktop');
    fs.mkdirSync(originalProfile, { recursive: true });
    const iumProfiles = path.join(input.homeDirectory, '.dsh-ium', 'profiles');
    fs.mkdirSync(iumProfiles, { recursive: true });
    fs.symlinkSync(originalProfile, path.join(iumProfiles, 'desktop'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => prepareIumIdentity({ ...input, env: {} }), /refuses to share/);
    assert.equal(fs.existsSync(path.join(originalProfile, 'cordis.patch.yml')), false);
  }
});

test('rejects credential-bearing registry URLs before creating Ium state', t => {
  const input = fixture(t);
  assert.throws(() => prepareIumIdentity({ ...input, env: { IUM_NPM_REGISTRY: 'https://user:example@packages.example.test/' } }), /without credentials/);
  assert.equal(fs.existsSync(path.join(input.homeDirectory, '.dsh-ium')), false);
});
