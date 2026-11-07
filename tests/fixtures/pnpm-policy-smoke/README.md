# Managed PNPM policy smoke

This fixture runs stock Electron **44.7.0 in Node mode**, never a GUI or the installed DSH application. It runs the real **PNPM 11.28.5** entry with the compiled Ium preload, matching the managed package-manager argument order. It is not complete PackageManager lifecycle coverage or packaged Desktop acceptance.

## Inputs and run

The caller must supply a frozen, reviewed compiled snapshot under the ignored `.work/` directory. Do not copy inputs while another process is rebuilding them. The snapshot contains `ium-node-preload.js`, `ium-network-policy.js`, their relative `ium-*` JavaScript dependencies, and `snapshot.json` with `files: [{ name, sha256, bytes }]`. Its directory must be ESM (for example a private `package.json` with `type: module`). Bare `undici` must resolve to the build's dependency.

The executable is read from `.work/electron-test-distribution.json`. PNPM is resolved from `.work/upstream/apps/desktop/node_modules/pnpm/package.json` and its `bin.pnpm` field, not a hardcoded user installation path. The fixture refuses other input versions.

```powershell
node scripts/pnpm-policy-smoke.mjs --snapshot-dir .work/pnpm-policy-smoke/<frozen-snapshot>
```

Run data, stdout/stderr, policy audit, per-process/per-worker facts and the final receipt are written to a unique `.work/pnpm-policy-smoke/run-*/` directory. Nothing is committed automatically.

## Offline containment

The first `--import` installs an independent inner failsafe. The second is the unmodified compiled Ium production preload; it wraps the failsafe. The failsafe permits the preload's pure-local `data:` initialization and HTTP connections only to the fixture registry's exact loopback port. It never delegates external DNS, external sockets or TLS connections. Subprocess execution is prohibited. PNPM's local worker threads are permitted only when they naturally inherit the ordered failsafe and Ium preloads; the fixture does not add missing policy propagation. Every worker must produce its own exit result.

Each invocation has an allowlisted environment and separate HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG paths, temporary directory, DSH_HOME, PNPM_HOME, cache/store/state/prefix, empty user npmrc and empty global npmrc. Reading npm/credential configuration outside the isolated case or PNPM's own package directory is denied. Update notifier and installation scripts are disabled. The loopback registry is a synthetic HTTP server; it neither proxies nor fetches anything.

## Required observations

1. `pnpm --version` exits zero and prints `11.28.5`.
2. A real `pnpm view` metadata request reaches the loopback registry, succeeds and returns the synthetic version.
3. A real `pnpm add` resolves the same synthetic package whose `dist.tarball` names `download.deepseek.com`; Ium rejects that request and PNPM exits nonzero.
4. The Ium policy audit names the prohibited host, while **every independent failsafe has zero denials**, zero real DNS queries, zero external connections and zero forbidden configuration reads.
5. The main process and all PNPM workers produce result files, record actual Node `24.21.0` and Electron `44.7.0`, observe the `data:` initialization and match the compiled module SHA-256 values. Missing results never count as success.

A general PNPM argument error, unrelated install failure, timeout, fail-safe interception or absent policy audit is a failure, even when PNPM exits nonzero. The receipt is explicitly snapshot-only; it cannot certify a subsequently rebuilt package.
