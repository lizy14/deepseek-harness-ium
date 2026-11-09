# Minimum packaged GUI smoke

This fixture targets a **completed Windows directory artifact**, not the original installed DSH, a source/dev server, or a single-file installer. It does not build the application, download a browser, authenticate a real account, send a model message, install a package, or invoke an agent tool.

## Run after the parent has qualified the artifact inputs

Use Node 24.21.0 and set `IUM_WORK_DIR` to the non-synchronized build directory. The default artifact is its `upstream/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked` folder. The runner imports the existing `playwright-core@1.61.1` package from that upstream dependency tree; it never installs Playwright or browsers.

```powershell
node scripts/gui-smoke.mjs --build-version 0.2.2-rc.1.20261108.1
# Optional controlled screenshots of this fresh fixture only:
node scripts/gui-smoke.mjs --artifact-dir '<absolute directory artifact>' --build-version '<exact candidate>' --screenshots
```

Each invocation creates a new `gui-smoke/run-<uuid>` beneath the work directory. A missing artifact produces a fresh FAIL without launching anything. Before launch, the runner verifies the ASAR application identity, requested version and ordinary/mandatory update metadata, and records EXE/ASAR hashes. It rechecks those hashes after shutdown.

## Isolation and checks

- Fresh `IUM_DSH_HOME`, `IUM_USER_DATA_DIR`, `HOME`, `USERPROFILE`, `APPDATA`, cache and temporary directories. Empty explicit user/global npm configuration; no real credentials or profiles copied.
- `--remote-debugging-port=0` and a fresh `DevToolsActivePort`; only a loopback browser endpoint is accepted. Chromium `SystemInfo.getProcessInfo` must report the PID actually launched by this run before `Browser.close` is permitted. No Node inspector is enabled.
- Chromium external DNS is denied. A local proxy rejects every forwarding/CONNECT/upgrade request. Node HTTP(S) proxy variables and `NODE_USE_ENV_PROXY=1` use that same proxy. A separate loopback registry supports ping and returns no installable packages.
- The runner reaches `dsh-app://app/`, checks a non-inert usable main UI, opens Plugins and observes its enabled add control **without clicking it**, then opens Settings → Models. The Models heading/selection must be visible and the DeepSeek account settings control absent. Known DeepSeek credential-onboarding copy is rejected; no login/notice is dismissed to hide a failure.
- DOM evidence contains only structural facts, recognized control labels and a body hash/length, not form values or a complete DOM dump. Screenshots are optional and remain local for review. Raw stdout/stderr may include ephemeral local endpoints and should not be published blindly.
- Production `logs/network-policy-blocks.jsonl`, rejecting-proxy observations and renderer requests are inspected. **Any observed DeepSeek attempt is FAIL, even if the guard blocked it.** Any unexpected proxy egress, malformed audit, renderer exception, forced/early exit or missing readiness is also failure.

PASS requires successful UI assertions, the exact owned PID's clean exit, unchanged artifact hashes and a final fresh PASS result. A missing result or wrapper exit alone never passes. The runner closes only its owned browser/PID; it does not find or kill processes by application name. It does not stop the original DSH.

These proxies are **not a firewall for arbitrary native processes or custom transports**. The result is a bounded fresh-home GUI smoke, not real Copilot login/inference, whole-device egress attestation, install/upgrade/uninstall qualification or a claim that every child process is contained. No Defender/TLS/sandbox weakening flags are used.

## Self-contained preparation tests

```powershell
node --check scripts/gui-smoke.mjs
node --test --test-isolation=none --test-concurrency=1 tests/fixtures/gui-smoke/self-test.mjs
```

These tests use synthetic ASAR identity data, pure UI/exit/audit records and loopback HTTP services. They do not execute an EXE or launch a browser; only a deliberately missing fixture artifact exercises the runner's early FAIL path. The parent must still run the real GUI smoke once its artifact exists.
