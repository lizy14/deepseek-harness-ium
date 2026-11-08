# Guarded packaged CLI

This entry applies to a newly built and verified artifact containing `ium-cli-bootstrap.js` and the matching patched CLI carrier. Do not copy a launcher into an older artifact or reuse an earlier Desktop acceptance result as proof that the new CLI is qualified.

## Entry and ownership

The Windows carrier remains at `resources/runtime/cli/bin/dsh.cmd` inside the directory artifact so upstream runtime inventory stays compatible. It invokes that installation's Ium executable in Node mode and the ASAR's Ium CLI bootstrap, not the original application. Its physical filename does **not** register or overwrite a system-wide `dsh` command. The official parser's `--version` reports the bundled Harness kernel version, not necessarily the downstream Desktop build identifier; use the artifact manifest and hashes to identify the complete distribution. Global aliases/PATH changes remain an explicit operator decision; the original Desktop command-registration menu stays disabled.

The bootstrap:

1. Resolves the same independent Ium data identity as Desktop, preserving the caller's working directory and arguments.
2. Clears inherited managed Session/Web/shell identity and the Desktop-only profile selection. The official CLI parser selects the requested CLI profile.
3. Finishes the Node policy preload before dynamically importing the official Desktop CLI carrier and its dependencies.
4. Supplies the immutable work overlay after all user patches and passes the same trusted preload to managed pnpm commands.

A failed identity or policy setup stops the command; there is no fallback to an unguarded original CLI. The official argument parser, package operations, Office resolution and Windows console-signal implementation are reused rather than copied into an independent CLI implementation.

`IUM_DSH_HOME` is the explicit independent-home override; merely inheriting `DSH_HOME` from another DSH process does not opt into its data. Relative roots and aliases into known original data roots are refused. As elsewhere, data-root isolation is not a filesystem sandbox: normal upstream project environment/configuration rules still apply.

## Profiles and authentication

Desktop and CLI share the Ium Harness home, but named CLI profiles retain their own model settings, bundles and plugins. The Desktop seed is not silently copied into every CLI profile. Configure the selected profile for an allowed provider and a model available to the account before running a task.

The upstream headless bundle intentionally disables the stored credential provider by default. If the operator wants headless to reuse authorization already stored in the Ium home, explicitly enable that service in the **headless profile**, for example:

```yaml
- id: credentials
  disabled: false
  config:
    dshHome: !!js process.env.DSH_HOME
    watch: false
```

This does not create authorization, install a sign-in plugin or select a model. Review the normal provider configuration and [data-preserving upgrade](upgrades-and-data.md) guidance; do not dump credential values or trigger a new OAuth flow just to check the CLI. A fresh login may have account-side effects, including Copilot model-policy changes.

The reserved Desktop profile retains the upstream CLI's existing restrictions. In particular, plugin management before a Desktop profile has actually been initialized is not silently converted into profile creation or data import.

## Effective configuration

The installation supplies `deploymentPatchFiles` programmatically. It is not a user-facing switch that can disable the work policy. Profile boot applies these patches after profile, home and user `--patch` layers, and keeps them in the profile context for recomposition.

Normal config dumps, default config dumps and schema dumps include the installation layer. A default dump excludes profile/home/argv patch layers, including broken user patch files, but still reads the profile manifest and its bundle selection and describes the installation's policy. It preserves upstream profile-initialization semantics, including the empty-root rewrite and any explicitly requested profile recreation: boot-free does not mean a generally read-only recovery command. Schema collection can import trusted module code, so it too enters through the guarded bootstrap.

The shared work overlay can mention entries absent from a headless or custom profile. Upstream's missing-entry warning/skip behavior remains visible; do not suppress all patch diagnostics to hide those differences. The process-level transport guard is installed independently of those entries.

## Qualification and limits

Core/source tests cover bootstrap order, identity, final-layer precedence, managed package-manager arguments, launcher rendering and fail-closed inspection. A particular release still needs exact-artifact CLI tests: help/version/dumps, permitted provider operation, argv/cwd/stdin/stderr/exit status, actual Windows interrupts and offline package-manager paths. POSIX source/rendering coverage is not native macOS qualification.

Build-time product names and ASAR entry components use a conservative ASCII allowlist to avoid batch-file code-page and shell-expansion ambiguity; installation directories can contain spaces and Unicode. The build rejects unsafe names and template drift rather than generating a different command.

The managed pnpm Node process is guarded, including metadata preflight. This does not claim containment of arbitrary lifecycle scripts, external git/curl/PowerShell processes, malicious same-user code or custom transports. See [policy scope](policy.md), [plugin feasibility](plugin-feasibility.md) and [verification](verification.md).
