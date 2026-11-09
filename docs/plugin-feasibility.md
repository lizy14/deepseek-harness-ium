# Why the work policy is not a normal DSH plugin

## Decision and requested behavior

Keep the patch-and-build approach for the work edition. Prevent requests to `deepseek.com`, `deepseeksvc.com` and their subdomains, including ordinary updates, mandatory-update policy, analytics, feedback and account/model/search traffic. Keep permitted services such as GitHub Copilot usable. This is **not** an offline edition.

A normal installable bundle is useful for feature configuration or a diagnostics UI, but cannot provide the complete application policy on the pinned upstream. Shipping such a bundle as the replacement would leave known startup requests uncovered. Ium therefore keeps the early bootstrap, producer-disabling changes and final deployment overlay together. A separate partial plugin is not required merely to package those settings differently.

This decision is scoped to the immutable upstream commit in [the lock](../upstream.lock.json), not a claim that future DSH extension APIs can never support this deployment.

## What the actual extension points can cover

| Surface | Normal plugin capability | Why it is not sufficient alone |
|---|---|---|
| Profile configuration | Bundle patches can disable known Host services before that profile tree mounts. | User/home/launcher layers can override an ordinary bundle; installation cannot undo an earlier startup request. |
| Host networking | Plugin code can wrap selected process-local APIs and disable known producers. | A wrapper loaded as a plugin is not an installation-owned preload before all entry dependencies; it does not govern another process. |
| Web client | `webserver/index-inject` can supply early head scripts; `dsh.client.immediately` participates in early module registration. | These are real Web hooks, not an Electron main-process hook. They do not own Chromium's redirects, every session or another process's requests. |
| Desktop main | The reviewed public package manifest has no normal plugin entry into main startup. | Ordinary and mandatory update checks are scheduled before the Host is reconciled, hence before a Host plugin can run. |
| Packaged CLI and package operations | Profile commands can load configured bundles. | CLI package-management commands can run without mounting the profile. They need a guarded launcher and a guarded managed package-manager command. |
| Arbitrary external programs | A plugin can launch or configure programs. | It cannot claim an OS security boundary over arbitrary PowerShell, Python, curl, native modules or transports that bypass the guarded APIs. |

Do not dismiss the real early Web hooks as nonexistent, and do not confuse them with a cross-process preload. Also distinguish request contributions from exporters: Session-log and plugin-inventory fields decorate model requests; the separate analytics/OTel exporters can use Node HTTP transports rather than global `fetch`.

## Source evidence

The following links name the **unmodified pinned upstream**, rather than line numbers from an already patched build checkout:

- [Desktop startup](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/apps/desktop/src/main.ts): launch update checks precede `reconcileBackend()`; focus/resume paths are additional producers.
- [Ordinary updater](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/apps/desktop/src/update-coordinator.ts) and [mandatory policy](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/apps/desktop/src/mandatory-update-policy.ts): disabling download is not disabling metadata/policy checks.
- [Package manifest types](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/util/package-manifest/src/types.ts), [profile boot](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/apps/cli/src/profile-boot.ts) and [boot implementation](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/app-boot/src/index.ts): the pre-mount `prepare` callback is supplied by the launcher, not registered by an installed plugin manifest.
- [Web index injections](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/host/webserver/src/injections.ts) and [client boot](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/web/src/boot.ts): legitimate early Web capabilities with narrower scope.
- [Electron preload bridge](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/apps/desktop/src/preload-app.ts): fixed IPC capabilities, not arbitrary main/network-hook installation.
- [CLI dispatch](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/apps/cli/src/bin.ts) and [packaged CLI carrier](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/apps/desktop-host/src/cli.ts): profile boot and package-management paths require separate coverage.

The downstream [bootstrap](../overlays/desktop/ium-bootstrap.mjs) installs the Node and Electron policy before dynamically importing main. The [network policy](../overlays/desktop/ium-network-policy.mjs) checks dispatches and Chromium requests, not only the first URL passed to `fetch`. The [final work overlay](../profiles/work.cordis.yml) disables known producers instead of replacing their endpoints with invalid addresses. [Patch groups](../patches/groups.json) identify the remaining owned upstream changes.

## What would make plugin-style distribution sufficient?

Upstream would first need an installation-owned, pre-network deployment hook that applies to Desktop main, the Host, supported CLI entry points and managed package operations, plus an authoritative way to disable their built-in producers. A configuration/diagnostics plugin could then use that core facility. A new plugin that rewrites ASAR files, replaces launchers or installs firewall rules is effectively an installer/system-policy tool; calling it a plugin does not remove those responsibilities.

Even with such hooks, arbitrary same-user native code needs separately approved environment-level controls for a stronger guarantee. Ium does not alter enterprise security policy to obtain that guarantee. See [policy scope](policy.md) and [verification requirements](verification.md).
