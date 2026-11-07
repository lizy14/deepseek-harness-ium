import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { root, work, upstream, readJson } from './lib.mjs';
import {
  hashFile, labels, isDeepSeek, hostname, routeSummary, assertNonSynced, newRunDirectory, writeResult,
  parseDevToolsPort, assertOwnedCdpPid, readAudit, summarizeDom, assessRun, startOfflineServices, isolatedEnvironment,
  readArtifactIdentity, validateIdentity, safeError,
} from '../tests/fixtures/gui-smoke/helpers.mjs';

const scope = 'Minimum fresh-home packaged GUI smoke only; not real Copilot login, model execution, install/upgrade/uninstall, arbitrary native-process containment or a machine-wide firewall.';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function parseArguments(args) {
  const options = { screenshots: false, timeoutMs: 180000 };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--screenshots') options.screenshots = true;
    else if (['--artifact-dir', '--build-version', '--timeout-ms'].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing option value');
      if (argument === '--artifact-dir') options.artifactDirectory = path.resolve(value);
      if (argument === '--build-version') options.expectedVersion = value;
      if (argument === '--timeout-ms') options.timeoutMs = Number(value);
    } else throw new Error('Unknown GUI smoke argument: ' + argument);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 10000 || options.timeoutMs > 300000) throw new Error('GUI timeout must be 10000..300000 milliseconds');
  return options;
}
async function waitFor(probe, description, deadline, processState) {
  while (Date.now() < deadline) {
    if (processState?.closed) throw new Error('Desktop exited before ' + description);
    const value = await probe();
    if (value) return value;
    await delay(200);
  }
  throw new Error('Timed out waiting for ' + description);
}
async function domSummary(page, stage) {
  const raw = await page.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    };
    const rootElement = document.querySelector('#root');
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible).map(element => (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 120));
    const headings = [...document.querySelectorAll('h1,h2,[role="heading"]')].filter(visible).map(element => (element.textContent || '').trim().slice(0, 120));
    return {
      url: location.href, rootPresent: !!rootElement, rootVisible: !!rootElement && visible(rootElement),
      rootInert: !!rootElement && (!!rootElement.inert || !!rootElement.closest('[inert]')),
      body: document.body?.innerText ?? '', buttons, headings,
      dialogCount: [...document.querySelectorAll('[role="dialog"],dialog[open]')].filter(visible).length,
    };
  });
  return summarizeDom(raw, stage);
}
async function isVisible(locator) { return await locator.count() > 0 && await locator.first().isVisible(); }
async function assertNoForcedLogin(page, stage) {
  const summary = await domSummary(page, stage);
  if (summary.forcedLogin.length) throw new Error('DeepSeek credential onboarding is visible at ' + stage);
  if (!summary.rootPresent || !summary.rootVisible || (stage !== 'models' && summary.rootInert)) throw new Error('Application is not interactable at ' + stage);
  return summary;
}

/** Launch only a declared directory artifact. No browser, package or model is downloaded/executed by this test. */
export async function runGuiSmoke(options = {}) {
  const workDirectory = path.resolve(options.workDirectory ?? work);
  const recipeRoot = options.rootDirectory ?? root;
  const upstreamDirectory = options.upstreamDirectory ?? upstream;
  const directory = newRunDirectory(workDirectory);
  const resultFile = path.join(directory, 'gui-smoke-result.json');
  const startedAt = new Date().toISOString();
  const result = {
    schemaVersion: 1, result: 'RUNNING', startedAt, directory, scope,
    offlineControls: { chromiumExternalDnsDenied: true, rejectingProxyDoesNotForward: true, nodeUseEnvProxy: true, nativeProcessesAreNotFirewalled: true },
    modelRequestsOrPackageInstallsRequested: false, screenshotsRequested: options.screenshots === true,
    ready: false, ui: {}, audit: { present: false, records: [], attempts: 0 }, proxy: { records: [] }, registryRequests: [], cdpAttempts: [],
    errors: [], rendererErrors: [], ownedProcess: null, artifactUnchanged: false,
  };
  writeResult(resultFile, result);
  let services, isolated, child, browser, browserSession, ownedBrowser = false, orderlyCloseRequested = false;
  let closePromise, stdout, stderr, manifest, executable, archive, overallTimer;
  const processState = { pid: null, status: null, signal: null, spawnError: null, closed: false, forced: false, premature: false, timedOut: false };
  const timeoutMs = options.timeoutMs ?? 180000;
  const deadline = Date.now() + timeoutMs;
  const stages = [];
  const phase = name => { stages.push({ name, time: new Date().toISOString() }); console.log('gui-smoke:', name); };
  try {
    phase('preflight');
    if (process.platform !== 'win32') throw new Error('This GUI recipe currently supports Windows directory artifacts only');
    if (process.versions.node !== '24.21.0') throw new Error('Use pinned Node 24.21.0 for this GUI runner');
    const profile = readJson(path.join(recipeRoot, 'profiles/work.json'));
    const expectedVersion = options.expectedVersion ?? readJson(path.join(recipeRoot, 'release-plan.json')).version;
    const artifactDirectory = path.resolve(options.artifactDirectory ?? path.join(upstreamDirectory, 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked'));
    assertNonSynced(artifactDirectory);
    executable = path.join(artifactDirectory, profile.identity.productName + '.exe');
    archive = path.join(artifactDirectory, 'resources/app.asar');
    if (!fs.existsSync(executable) || !fs.existsSync(archive)) throw new Error('Directory artifact is not ready; no application was launched');
    const realExecutable = fs.realpathSync.native(executable), realArtifact = fs.realpathSync.native(artifactDirectory);
    if (!realExecutable.startsWith(realArtifact + path.sep)) throw new Error('Artifact executable escaped its declared directory');
    manifest = readArtifactIdentity(archive);
    validateIdentity(manifest, profile, expectedVersion);
    if (fs.existsSync(path.join(artifactDirectory, 'resources/app-update.yml'))) throw new Error('Unexpected packaged ordinary update feed');
    result.artifact = { version: manifest.version, packageName: manifest.name, executable: realExecutable, archive, hashes: { executable: hashFile(executable), archive: hashFile(archive) } };
    const playwrightRoot = path.join(upstreamDirectory, 'node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
    const playwrightMetadata = readJson(path.join(playwrightRoot, 'package.json'));
    if (playwrightMetadata.version !== '1.61.1') throw new Error('Unexpected playwright-core version; do not download another browser/runtime');
    const { chromium } = await import(pathToFileURL(path.join(playwrightRoot, 'index.mjs')).href);
    services = await startOfflineServices();
    isolated = isolatedEnvironment(directory, services);
    result.isolatedDirectories = { harnessHome: isolated.folders['dsh-home'], userData: isolated.folders['user-data'], home: isolated.folders.home, appData: isolated.folders.appdata };
    const args = [
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--user-data-dir=' + isolated.folders['user-data'], '--lang=en-US',
      '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--proxy-server=' + services.proxyUrl, '--proxy-bypass-list=127.0.0.1;localhost',
    ];
    stdout = fs.openSync(path.join(directory, 'stdout.log'), 'wx');
    stderr = fs.openSync(path.join(directory, 'stderr.log'), 'wx');
    phase('launch-owned-desktop');
    child = spawn(realExecutable, args, { cwd: artifactDirectory, env: isolated.env, stdio: ['ignore', stdout, stderr], windowsHide: true });
    processState.pid = child.pid ?? null;
    closePromise = new Promise(resolve => {
      child.once('error', error => { processState.spawnError = safeError(error); });
      child.once('close', (status, signal) => {
        processState.status = status; processState.signal = signal; processState.closed = true;
        processState.premature = !orderlyCloseRequested;
        resolve();
      });
    });
    overallTimer = setTimeout(() => {
      if (!processState.closed) {
        processState.timedOut = true; processState.forced = true;
        child.kill('SIGTERM');
      }
    }, Math.max(1000, deadline - Date.now()));
    const portFile = path.join(isolated.folders['user-data'], 'DevToolsActivePort');
    const endpoint = await waitFor(() => {
      if (!fs.existsSync(portFile)) return null;
      try { return parseDevToolsPort(fs.readFileSync(portFile, 'utf8')); } catch { return null; }
    }, 'owned DevToolsActivePort', deadline, processState);
    result.cdp = { host: '127.0.0.1', port: endpoint.port, transport: 'Chromium CDP', nodeInspectorEnabled: false };
    // CDP is always loopback. Prevent inherited proxy preferences from routing that connection externally.
    const previousNoProxy = [process.env.NO_PROXY, process.env.no_proxy];
    try {
      process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost,::1';
      browser = await chromium.connectOverCDP(endpoint.url, { timeout: Math.min(30000, Math.max(1000, deadline - Date.now())) });
    } finally {
      for (const [index, key] of ['NO_PROXY', 'no_proxy'].entries()) {
        if (previousNoProxy[index] === undefined) delete process.env[key]; else process.env[key] = previousNoProxy[index];
      }
    }
    browserSession = await browser.newBrowserCDPSession();
    const processInfo = await browserSession.send('SystemInfo.getProcessInfo');
    const browserPid = assertOwnedCdpPid(processInfo, child.pid);
    ownedBrowser = true;
    result.cdp.browserPid = browserPid;
    const observePage = page => {
      page.on('request', request => {
        const url = request.url(), name = hostname(url);
        if (isDeepSeek(name)) result.cdpAttempts.push({ hostname: name, deepseek: true, source: 'renderer-request' });
      });
      page.on('pageerror', error => { if (result.rendererErrors.length < 20) result.rendererErrors.push(safeError(error)); });
    };
    for (const context of browser.contexts()) {
      for (const page of context.pages()) observePage(page);
      context.on('page', observePage);
    }
    const page = await waitFor(() => browser.contexts().flatMap(context => context.pages()).find(page => {
      const route = routeSummary(page.url()); return route.protocol === 'dsh-app:' && route.hostname === 'app';
    }), 'Ium main application page (not welcome/login)', deadline, processState);
    page.setDefaultTimeout(15000);
    await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1000, deadline - Date.now()) });
    const sidebar = page.getByRole('button', { name: labels.sidebar });
    if (await isVisible(sidebar)) await sidebar.first().click();
    const plugins = page.getByRole('navigation', { name: labels.panels }).getByRole('button', { name: labels.plugins, exact: true });
    await plugins.waitFor({ state: 'visible', timeout: Math.min(60000, Math.max(1000, deadline - Date.now())) });
    const settings = page.getByRole('button', { name: labels.settings, exact: true });
    await settings.first().waitFor({ state: 'visible' });
    result.ready = true;
    phase('main-ready');
    result.ui.main = { ...await assertNoForcedLogin(page, 'main'), pluginsReachable: await plugins.isEnabled(), settingsReachable: await settings.first().isEnabled() };
    fs.writeFileSync(path.join(directory, 'main.dom.json'), JSON.stringify(result.ui.main, null, 2));
    if (options.screenshots) await page.screenshot({ path: path.join(directory, 'main.png'), fullPage: false });
    await plugins.click();
    const pluginsHeading = page.getByRole('heading', { name: labels.plugins, exact: true });
    const add = page.getByRole('button', { name: labels.addPlugin, exact: true });
    await pluginsHeading.first().waitFor({ state: 'visible' });
    await add.first().waitFor({ state: 'visible' });
    result.ui.plugins = { ...await assertNoForcedLogin(page, 'plugins'), headingVisible: await pluginsHeading.first().isVisible(), addControlVisible: await add.first().isVisible(), addControlEnabled: await add.first().isEnabled() };
    fs.writeFileSync(path.join(directory, 'plugins.dom.json'), JSON.stringify(result.ui.plugins, null, 2));
    if (options.screenshots) await page.screenshot({ path: path.join(directory, 'plugins.png'), fullPage: false });
    phase('plugins-reachable-no-install');
    await page.getByRole('button', { name: labels.settings, exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: labels.settings, exact: true });
    await dialog.waitFor({ state: 'visible' });
    const models = dialog.getByRole('button', { name: labels.models, exact: true });
    await models.click();
    const modelsHeading = dialog.getByRole('heading', { name: labels.models, exact: true });
    await modelsHeading.first().waitFor({ state: 'visible' });
    await waitFor(async () => ['true', 'page'].includes(await models.getAttribute('aria-current')), 'selected Models settings', deadline, processState);
    result.ui.models = {
      ...await assertNoForcedLogin(page, 'models'), dialogVisible: await dialog.isVisible(), selected: ['true', 'page'].includes(await models.getAttribute('aria-current')),
      headingVisible: await modelsHeading.first().isVisible(), accountControlVisible: await isVisible(dialog.getByRole('button', { name: labels.account, exact: true })),
    };
    fs.writeFileSync(path.join(directory, 'models.dom.json'), JSON.stringify(result.ui.models, null, 2));
    if (options.screenshots) await page.screenshot({ path: path.join(directory, 'models.png'), fullPage: false });
    phase('models-reachable-no-model-request');
    // Bounded observation after UI settles; intentionally no banned-domain challenge or user task.
    await delay(3000);
  } catch (error) {
    result.errors.push(safeError(error));
  } finally {
    phase('stop-owned-process');
    if (child && !processState.closed) {
      orderlyCloseRequested = true;
      if (ownedBrowser && browserSession) {
        try { await Promise.race([browserSession.send('Browser.close'), delay(5000).then(() => { throw new Error('CDP close request did not settle'); })]); }
        catch (error) { result.closeRequestNote = safeError(error); }
      }
      await Promise.race([closePromise, delay(10000)]);
      if (!processState.closed) {
        processState.forced = true;
        child.kill('SIGTERM'); // ChildProcess owns this handle; never kill by name or an unrelated PID.
        await Promise.race([closePromise, delay(10000)]);
      }
      if (!processState.closed) result.errors.push('Owned Desktop has not reported process completion after termination');
    }
    clearTimeout(overallTimer);
    if (browser) { try { await Promise.race([browser.close(), delay(3000)]); } catch { /* The owned browser may already have exited. */ } }
    if (stdout !== undefined) fs.closeSync(stdout);
    if (stderr !== undefined) fs.closeSync(stderr);
    if (services) {
      result.proxy = { records: services.records };
      result.registryRequests = services.registryRequests;
      await services.close();
    }
    if (isolated) {
      try { result.audit = readAudit(path.join(isolated.folders['dsh-home'], 'logs/network-policy-blocks.jsonl')); }
      catch (error) { result.errors.push('Cannot validate production audit: ' + safeError(error)); }
      try {
        result.emptyNpmConfigs = isolated.emptyNpmConfigs.every(file => fs.readFileSync(file, 'utf8') === '');
        if (!result.emptyNpmConfigs) result.errors.push('Isolated empty npm configuration changed');
      } catch (error) { result.errors.push('Cannot validate isolated npm configuration: ' + safeError(error)); }
    }
    if (result.artifact) {
      try { result.artifactUnchanged = hashFile(executable) === result.artifact.hashes.executable && hashFile(archive) === result.artifact.hashes.archive; }
      catch (error) { result.errors.push('Cannot revalidate artifact: ' + safeError(error)); }
    }
    result.ownedProcess = child ? processState : null;
    result.errors.push(...assessRun({ exit: result.ownedProcess, ui: result.ui, audit: result.audit, proxy: result.proxy, cdpAttempts: result.cdpAttempts, artifactUnchanged: result.artifactUnchanged, ready: result.ready }));
    if (result.rendererErrors.length) result.errors.push('Renderer raised an uncaught page error');
    result.result = result.errors.length === 0 ? 'PASS' : 'FAIL';
    result.finishedAt = new Date().toISOString(); result.stages = stages;
    result.noDeepSeekProducerAttemptsObserved = result.result === 'PASS' && result.audit.attempts === 0 && result.proxy.records.length === 0 && result.cdpAttempts.length === 0;
    result.minimumGuiAcceptancePassed = result.result === 'PASS';
    result.fullDesktopQualification = false;
    writeResult(resultFile, result);
  }
  console.log(JSON.stringify({ result: result.result, resultFile, minimumGuiAcceptancePassed: result.minimumGuiAcceptancePassed, fullDesktopQualification: false, errors: result.errors }, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('node scripts/gui-smoke.mjs [--artifact-dir <directory>] [--build-version <version>] [--screenshots] [--timeout-ms 180000]');
  else {
    try { const result = await runGuiSmoke(parseArguments(process.argv.slice(2))); process.exitCode = result.result === 'PASS' ? 0 : 1; }
    catch (error) { console.error(safeError(error)); process.exitCode = 1; }
  }
}
