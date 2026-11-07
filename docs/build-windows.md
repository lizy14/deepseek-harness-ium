# Build an unsigned Windows candidate

## Prerequisites

Use Windows x64, Node 24.21.0, pnpm 11.28.5, Python, Git, PowerShell, tar, Visual C++ x86/x64 tools and a Windows SDK. The upstream preflight checks the actual native toolchain. A directory build still compiles installer support and validates the complete runtime; it is not a shortcut around those requirements.

Use the pinned Node as `node`, or invoke its absolute executable path. The wrappers prepend that Node directory for nested commands. Set `IUM_PNPM_ENTRY` to an existing absolute, matching pnpm CLI file when using a standalone Node distribution without npm; otherwise the toolchain command installs pnpm locally without lifecycle scripts.

On an enterprise machine, set `IUM_NPM_REGISTRY` to an approved HTTPS registry base URL before dependency installation. Path prefixes such as `/npm/` are supported by the downstream patch. Do not copy authenticated npm files into the repository. This setting is an operator input, not a universal corporate default.

For local Windows builds, prefer a dedicated non-synchronized directory via `IUM_WORK_DIR` (for example a new `DSH-Ium-Build` directory under LocalAppData). This relocates generated checkouts, caches, temporary files and validation records; the source recipe stays in this repository. It does not change Windows permissions or security policy. Paths shown under `.work/` below describe the default when no override is set.

## Commands

Run from this repository's root:

```powershell
node scripts/toolchain.mjs
node scripts/upstream.mjs
node scripts/apply.mjs
node scripts/dependencies.mjs --build-reviewed-deps
node --test --test-isolation=none --test-concurrency=1 'tests/*.test.mjs'
node scripts/test-upstream.mjs
node scripts/compile.mjs
node scripts/prepare-electron.mjs
node scripts/native-smoke.mjs --compiled
node scripts/build-windows.mjs --build-version 0.2.2-rc.1.20261107.1 --check
node scripts/build-windows.mjs --build-version 0.2.2-rc.1.20261107.1 --dir
```

The version is an explicit candidate example. Check retained and published versions before choosing a new one; do not use `auto`. The wrapper generates an ignored Windows build configuration containing only Ium's application ID. It refuses to overwrite a different existing configuration.

Dependencies are first installed with lifecycle scripts disabled. The optional `--build-reviewed-deps` stage runs only the pinned upstream's reviewed esbuild, node-pty and Koffi builds. No signing credentials, model API keys or inherited agent session identity are passed to build subprocesses. Compiler temporary files and Harness data are isolated; `IUM_BUILD_TEMP_DIR` may select another explicit absolute scratch directory.

The output directory is:

```text
.work/upstream/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked
```

Keep the entire directory together. Its executable is not a single-file portable distribution. Removing `--dir` requests the upstream NSIS installer path, which requires separate installer/uninstaller qualification. This project does not automatically install, sign or publish either output.

## CI and release

[The separately reviewed Windows CI template](https://github.com/lizy14/deepseek-harness-ium/blob/test/extended-validation/ci/windows-build.yml) pins Actions commits and uses a fresh hosted runner without signing secrets. It is intentionally stored outside the active workflows directory. Enabling it requires placing it at `.github/workflows/windows-build.yml` using a credential with GitHub's `workflow` permission. A `repo`-only OAuth token is insufficient; do not switch to a different account to evade that restriction.

The template uploads unsigned candidates, not a production Release. Require the [verification stages](verification.md) and review the exact source input digest, version, runtime inventories and output hashes before publication. Retain the generated runtime dependency lock and packaging records: an upstream frozen workspace lock alone does not freeze every dependency materialized into the Desktop runtime.

## Updating the patches

Change the upstream lock deliberately and use a clean checkout of that exact commit. No helper runs a destructive reset or silently resolves conflicts. After reviewing source edits, export the declared groups:

```powershell
node scripts/export-patches.mjs
node scripts/apply.mjs --refresh-overlays
node scripts/verify.mjs
```

The refresh flag only replaces an overlay that still matches its previously recorded generated digest; unmanaged edits remain protected. Re-run affected tests and the build after changes. Keep the existing official installation and credentials separate throughout qualification.
