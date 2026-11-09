# Native Electron policy component smoke

This fixture is **not the original installed Desktop application** and is not a packaged Desktop acceptance test. It checks real Electron method replacement, URL-filter registration/combination, subsequent `null` cleanup, per-session requests and allowed/blocked redirects.

## Run in parent CI

Use a separate test Electron distribution matching the target build. Do not invoke the existing installed DeepSeek Harness executable, do not change its resources, and do not pass `--no-sandbox` or disable TLS/signature checks.

Set `IUM_POLICY_SMOKE_DIR` to a fresh absolute, isolated artifact directory and launch Electron with this fixture directory as its application. Clear any inherited `ELECTRON_RUN_AS_NODE`. Optionally set `IUM_POLICY_MODULE` to the **local file URL** of the exact staged overlay; otherwise the fixture loads `../../../overlays/desktop/ium-network-policy.mjs` relative to its main module.

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
$env:IUM_POLICY_SMOKE_DIR = '<absolute isolated artifact directory>'
& '<test Electron executable>' 'tests/fixtures/electron-policy-smoke'
```

The parent runner must wait for process completion and require all of:

- exit code zero;
- `network-policy-native-smoke.json` exists and has `result: "PASS"`;
- the reported `sourcePolicySha256` matches the overlay actually staged for the build;
- `forbiddenProxyAttempts: 0` and no independent Node fail-safe rejections.

No result file, a timeout, native startup failure, or a filter-registration error is **failure**, even if a GUI launcher reports an empty/zero exit code. The fixture has a 20-second in-process deadline; CI still needs its own process timeout for failures before JavaScript executes.

## Independent offline safety

The fixture installs the independent Node test fail-safe before Ium, denies external Chromium DNS through host-resolver rules, and routes HTTP(S) through a fixed loopback rejecting proxy. The proxy never forwards a request or resolves its target. Requests use no credentials. These controls are test scaffolding, not changes to production Defender, TLS or application sandbox policy.

The Node suite shares the independent fail-safe and can run without Electron. It additionally uses a real forward proxy which forwards only to one fixed loopback fixture; both a conventional ProxyAgent and a custom reusable dispatcher must reject an HTTP redirect before the proxy receives the prohibited target. The parent repository must provide the pinned `undici@7.29.1` dependency; do not install an ad-hoc fixture version.

Run:

```text
node --test --test-isolation=none tests/network-policy.test.mjs
```

This mode avoids test-runner subprocess pipes in confined Windows environments. The normal native test does not run as part of that suite.

## Production integration contract

The policy hooks install only through the explicit installers. Undici can initialize its default Agent on import, so the parent bootstrap first initializes Node's native fetch/ambient proxy dispatcher through a local data URL, then dynamically imports this overlay. The installer wraps and later restores the existing dispatcher rather than constructing its own Agent. Create one process owner, install before application dependencies, then protect Electron before Session/webRequest owners:

```js
const initialized = await globalThis.fetch('data:,ium-policy-initialize');
await initialized.body?.cancel();
const { createPolicyOwner, installNodePolicy, installElectronPolicy } = await import(policyModuleUrl);
const owner = createPolicyOwner({ audit });
installNodePolicy(owner);
installElectronPolicy({ app, session, net, shell }, owner);
```

The Host is another process and needs its own early preload and owner. Keep owners for process lifetime. `dispose()` exists for tests or shutdown after all clients are stopped; do not remove a live guard while requests can still be emitted. Install neither policy for household editions unless explicitly selected by that deployment.

Disable producers (ordinary and mandatory updater, telemetry, unwanted providers) separately. Native global fetch preserves its redirect semantics while every dispatcher hop checks origin, absolute proxy path, CONNECT authority and Host/:authority before delegating. This also covers per-request fetch dispatchers and ordinary HTTP forward-proxy connection reuse; it does not rely on new target sockets. The installed default global dispatcher protects normal Undici APIs too; a non-fetch caller that deliberately installs or invokes an unguarded dispatcher outside these entry points needs separate integration.

This remains application HTTP/Chromium enforcement, not an OS firewall for arbitrary external programs, malicious plugins/dispatchers that rewrite an approved target internally, native/custom connectors, raw-IP clients without a matching hostname/authority, Workers that replace their preload arguments, or previously cached unguarded primitives. Node mocked Electron tests do not prove native API compatibility; this smoke does not prove the entire packaged Desktop boots or authenticates Copilot.
