# DSH Ium

An unofficial, independent patch-and-build repository for DeepSeek Harness Desktop. It fetches a pinned public upstream commit rather than maintaining a second copy of upstream history.

**Development status:** no installer is published or qualified yet. Passing source tests is not a packaged Desktop acceptance result. The existing official installation and its data are not replaced by this repository.

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
- [Patch series](patches/series.json) and [declared overlay files](overlays.json)
- [Official controls and open discussions](docs/upstream-controls.md)

Registry URLs are local deployment inputs through `IUM_NPM_REGISTRY`; corporate endpoints and authentication are not universal defaults. The initial `github-copilot` / `gpt-4.1` seed is user-editable: install a compatible Copilot sign-in plugin, authenticate again and select a model your account actually offers. No subscription or model availability is implied.

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

## Maintenance

Update the upstream lock deliberately, review and refresh the small patch series, and rerun the checks. The patch application refuses unmanaged edits rather than silently merging them. `.work/`, machine configuration, credentials, dependency stores and build output are ignored. Never commit a user Harness home or an authenticated npm configuration.

The upstream application is MIT-licensed; retain its notices and the licenses shipped with dependencies. Ium is not endorsed by DeepSeek. The original source fork at [lizy14/deepseek-harness](https://github.com/lizy14/deepseek-harness) is separate and remains unchanged.
