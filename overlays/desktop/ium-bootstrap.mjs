import { app, session, net, shell, protocol } from 'electron';
import build from './ium-build.json' with { type: 'json' };
import { SCHEME } from '../lib/types/ipc.js';
import { prepareIumIdentity } from './ium-identity.mjs';
import { createPolicyAudit } from './ium-audit.mjs';

// Only builtins, immutable build data and the dependency-free IPC constants load synchronously.
app.setName(build.identity.packageName);
const identity = prepareIumIdentity({
  identity: build.identity,
  initialModel: build.initialModel,
  homeDirectory: app.getPath('home'),
  appDataDirectory: app.getPath('appData'),
});
app.setPath('userData', identity.userData);
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);
// A data URL initializes Node's own dispatcher without DNS or a connection, retaining its proxy policy.
await (await globalThis.fetch('data:,ium-policy-initialize')).arrayBuffer();
const { createPolicyOwner, installNodePolicy, installElectronPolicy } = await import(new URL('./ium-network-policy.js', import.meta.url).href);
const networkPolicy = createPolicyOwner({ audit: createPolicyAudit(identity.harnessHome) });
installNodePolicy(networkPolicy);
installElectronPolicy({ app, session, net, shell }, networkPolicy);
await import(new URL('./main.js', import.meta.url).href);
