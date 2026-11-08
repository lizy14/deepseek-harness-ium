# Upgrades that preserve user data

An independent application identity does **not** mean users should lose history, reinstall their plugins or authenticate again for each update.

## Two different operations

| Operation | Expected data behavior |
|---|---|
| Ium → a newer compatible Ium build | Replace the application code while retaining the existing Ium Harness home and Electron user-data directory. Do not repeat an import or create version-specific data homes. |
| Official DSH → Ium for the first time | Keep the original application available, then explicitly hand over a complete, verified cold copy of its data to Ium's separate roots. This can preserve the upgrade experience without sharing two live writers. |

The bootstrap never copies credentials or profiles automatically and refuses aliases into known original data roots. That protects users from accidental reuse; it is not a requirement to start from an empty account. Explicit data migration remains an operator action. This repository does not yet ship a qualified, automatic general-purpose migration tool.

## Before the handover

1. Record the exact source/target versions, artifact hashes and active processes. Check the stored Session format and other persistent-store compatibility, not just the application version string. Refuse unknown or incompatible formats; do not rewrite a header to make it look compatible.
2. Save active work and coordinate a maintenance window. If the agent preparing the upgrade is itself running in the old Host, persist a short recovery handoff and move the controller to an independent external terminal. A job owned by the shutting-down Host is not a reliable upgrade supervisor.
3. Normal-exit the old Desktop/Host and other writers. Pause launches of the new application and CLI until copying and activation finish. Do not use blanket process-name termination as the migration procedure.
4. Identify every data root and any external workspace references. Use non-synchronized staging, backup and diagnostic directories. Do not copy user data into the build repository or include it in a binary release.

## Preserve a coherent set of data

Inventory the actual installation. It can include:

- Session generations, parent/child histories, attachments and workspace associations;
- profile manifests, user configuration, installed plugin packages and plugin-owned state;
- credentials, local identity and Remote keys/trust/authorization state;
- the Electron user-data directory and application preferences;
- runtime-owned data and caches required by that installation.

Copy from a quiescent source, preserve effective access controls, and verify file contents before activation. Keep the original data untouched and retain any existing target data separately. When merging a previously used Ium home, preserve target-only conversations and attachments; a duplicate identity with different contents is a conflict, not permission to overwrite.

Some caches can be rebuilt, but they must not be confused with authoritative history or authentication. Cross-machine or cross-OS copies of encrypted credentials/cookies are not guaranteed to remain usable; use the relevant service's supported recovery flow when required.

Session headers and their physical project-directory keys are related persistence identities. Do not rename those directories, replace paths throughout a log, discard child sessions, or edit historical headers to relocate a workspace. Any necessary directory transition must use a supported, validated mechanism on an independent copy. Preserve the original records and check effective working directories before resuming tasks. Workspace-index changes are a separate operation and must retain workspace and Session IDs.

## Authentication and Remote

Retaining compatible data normally avoids a new login. A login flow is not automatically a harmless read-only check: the pinned Copilot OAuth implementation may try to enable eligible model policies after device authorization. Do not initiate that flow, broaden model permissions or modify account policy merely to verify an upgrade. Existing authorization may still require an ordinary token refresh.

Remote or other plugins may store a stable device identity and rotating refresh credentials. Two directory copies can therefore represent **the same remote identity**, not two independent accounts. Do not run both copies concurrently. A refresh lock may protect only one local directory; copying it does not create cross-copy exclusion. Preserve credentials and effective ACLs, refuse unresolved locks rather than stealing them, and review the particular plugin's storage contract.

## Rollback is not always restoring stale data

Keep these cases distinct:

- **Before new code has used the copied data:** the untouched source and retained target snapshot support a straightforward rollback of activation.
- **After the new instance has refreshed authentication or accepted new work:** reverting to an old snapshot can discard conversations or restore a consumed refresh token. Prefer a compatible code rollback over the current data, or a separately verified cold handback of the latest state. Do not blindly start the old copy alongside the new one.

Verify the old code's reader compatibility and data-root controls before relying on such a rollback. A preserved executable is useful recovery material, not proof that every future data/schema change is reversible. Reopening the original official build can also restore its original update and telemetry behavior; it is not a way to satisfy the work-edition network policy.

## After activation

Verify application/Host/CLI identity and exact artifact hashes, visible history and settings, a small allowed-provider operation, and absence of old producers. Check policy audit records and an appropriate bounded external observation such as Defender events. A fresh-home GUI smoke alone does not establish a successful full-data upgrade.

Do not infer “no networking” from an absent audit file or relabel private local acceptance as public installer qualification. See [policy scope](policy.md), [verification stages](verification.md) and [the Windows build guide](build-windows.md).
