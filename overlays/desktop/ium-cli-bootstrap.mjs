import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import build from './ium-build.json' with { type: 'json' };
import { prepareIumIdentity } from './ium-identity.mjs';

/** Resolve only the supported platform's user-data root; never import Electron in Node mode. */
export function cliAppDataDirectory(home, platform = process.platform, env = process.env) {
  if (!path.isAbsolute(home)) throw new Error('Ium CLI home must be absolute');
  if (platform === 'win32') {
    const directory = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    if (!path.isAbsolute(directory)) throw new Error('Ium CLI APPDATA must be absolute');
    return directory;
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  throw new Error('Ium packaged CLI supports Windows and macOS paths only');
}

/** Installation-owned entry: identity and policy complete before any public CLI dependency loads. */
export async function runIumCli() {
  const home = homedir();
  prepareIumIdentity({
    identity: build.identity,
    initialModel: build.initialModel,
    homeDirectory: home,
    appDataDirectory: cliAppDataDirectory(home),
  });
  // The shared identity seeds Desktop, but argv owns a CLI invocation's actual profile.
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_PROFILE_DIR;
  const networkPreload = new URL('./ium-node-preload.js', import.meta.url).href;
  await import(networkPreload);
  const runtimeDir = fileURLToPath(new URL('../dsh/', import.meta.url));
  const supportDir = fileURLToPath(new URL('../../runtime/', import.meta.url));
  const deployment = fileURLToPath(new URL('../dsh/node_modules/@deepseek-ai/dsh-desktop-host/ium-work.cordis.yml', import.meta.url));
  const { runDesktopCli } = await import(new URL('../dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js', import.meta.url).href);
  await runDesktopCli(runtimeDir, supportDir, {
    deploymentPatchFiles: [deployment],
    networkPreload,
  });
}

if (import.meta.main) await runIumCli();
