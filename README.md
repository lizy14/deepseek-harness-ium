# DSH Ium

An unofficial, independent patch-and-build repository for DeepSeek Harness Desktop. It fetches a pinned public upstream commit rather than maintaining a second copy of upstream history.

**Development status:** no installer is published or qualified yet. Passing source tests is not a packaged Desktop acceptance result. The existing official installation and its data are not replaced by this repository.

## Why “-ium”?

The `-ium` suffix is a naming analogy to **Chrome / Chromium** and **VS Code / VSCodium**: a recognizable relationship to upstream code, with independently built binaries, branding, defaults and update policy.

The project relationships are not identical. Chromium is upstream of Chrome; **DSH Ium is an unofficial downstream build of the already-open-source DeepSeek Harness**, not a new upstream or an official DeepSeek edition. Like VSCodium's build-repository approach, this repository maintains a small patch set and build recipes rather than a second copy of the complete source history. The name itself is not a security guarantee; the tested policy and its limits are documented below.

## Work edition

The current recipe targets Windows x64 and the `work-no-deepseek` policy:

- No ordinary or mandatory Desktop update queries, DeepSeek native onboarding, account-page launches, or original `dsh://` / `dsh` command registration.
- Product analytics, feedback telemetry, Session-log and plugin-inventory request contributions disabled by a final deployment overlay.
- Built-in DeepSeek model and search providers disabled; non-DeepSeek providers, including GitHub Copilot, remain available.
- Early Node/Undici and Electron request enforcement for `deepseek.com`, `deepseeksvc.com` and their subdomains, including tested redirects and proxy connection reuse.
- Independent application identity, user-data directory, Harness home and default workspace. Existing credentials and plugin state are never copied automatically.

This is an **application transport policy, not an operating-system firewall**. It does not contain malicious plugins, arbitrary native code, raw-IP/custom transports outside the guarded interfaces, or external programs such as a separately launched curl. Work-device policy is not automatically applicable to household devices. See [policy scope](docs/policy.md).

## Sources and inputs

- [Pinned upstream and toolchain](upstream.lock.json)
- [Work-edition identity and initial model seed](profiles/work.json)
- [Final deployment overlay](profiles/work.cordis.yml)
- [Ordered patch groups](patches/groups.json) and [declared overlay files](overlays.json)
- [Official controls and open discussions](docs/upstream-controls.md)

Registry URLs are local deployment inputs through `IUM_NPM_REGISTRY`. **Organization-specific registry addresses, internal endpoints, tenant/account identifiers, machine paths and authentication must never be committed or pushed to this public repository—even when they contain no password.** Keep those values in ignored local configuration or the operator's environment; public tests use reserved example domains. The initial `github-copilot` / `gpt-4.1` seed is user-editable: install a compatible Copilot sign-in plugin, authenticate again and select a model your account actually offers. No subscription or model availability is implied.

## Build and verification

Read [the Windows build guide](docs/build-windows.md). The build uses Node 24.21.0 and pnpm 11.28.5, checks the exact upstream commit, refuses patch conflicts and records the reviewed source inputs. Windows packaging also needs the upstream native toolchain and dependency downloads.

```sh
node scripts/toolchain.mjs
node scripts/upstream.mjs
node scripts/apply.mjs
node scripts/dependencies.mjs --build-reviewed-deps
npm test
node scripts/test-upstream.mjs
node scripts/build-windows.mjs --build-version 0.2.2-rc.1.20261107.1 --check
node scripts/build-windows.mjs --build-version 0.2.2-rc.1.20261107.1 --dir
```

The version above is an explicit example candidate, not an available release. Do not use `auto`, which can invoke upstream version-discovery services. A directory build still runs upstream runtime, ASAR, native dependency and Office smoke checks. Separate native policy and complete Desktop acceptance remain required before release claims.

[Verification details](docs/verification.md) distinguish source tests, native policy smoke, complete application startup, real-provider setup and installer qualification. Unsigned artifacts are not official DeepSeek releases and may be rejected by enterprise execution policy; do not lower system protection to run them.

## Review structure

The core change contains the runtime policy, two upstream patches, build/verification commands and their unit/native-component tests. The larger packaged-GUI and package-manager acceptance runners, plus the inactive CI template, are reviewed separately in the [extended-validation branch](https://github.com/lizy14/deepseek-harness-ium/tree/test/extended-validation). They remain required evidence for the corresponding release claims; splitting the review does not remove those checks.

## Maintenance

Update the upstream lock deliberately, review and refresh the small patch series, and rerun the checks. The patch application refuses unmanaged edits rather than silently merging them. `.work/`, machine configuration, credentials, dependency stores and build output are ignored. Never commit a user Harness home or an authenticated npm configuration.

The upstream application is MIT-licensed; retain its notices and the licenses shipped with dependencies. Ium is not endorsed by DeepSeek. The original source fork at [lizy14/deepseek-harness](https://github.com/lizy14/deepseek-harness) is separate and remains unchanged.
