# Work-edition policy

## Scope

The work edition blocks `deepseek.com`, `deepseeksvc.com` and their subdomains in its managed application transports. Hostnames are normalized rather than substring-matched, so unrelated hosts such as `github.com` are not prohibited. This is separate from corporate registry configuration and is not automatically a household deployment policy.

The deployment overlay disables built-in DeepSeek model/search providers, the account UI, automatic credential onboarding, product analytics, feedback telemetry, Session-log and plugin-inventory contributions. Desktop startup, focus, resume and manual update handlers do not query either upstream update service. The package carries no ordinary update feed or mandatory policy metadata in the supported unsigned recipe.

## Enforcement

A separate Electron bootstrap isolates data and registers the internal application scheme synchronously. A local `data:` fetch initializes Node's existing dispatcher without network I/O; the policy then loads, followed by a dynamic import of the upstream main module. The Host and its managed package-manager Node command receive an explicit preload before their entry dependencies.

The process-owned policy checks Node HTTP(S), native fetch input and dispatch, proxy authorities, DNS/socket/TLS destinations, and Electron request/navigation entry points. Undici dispatch checks run for redirects and reused proxy connections, before forwarding to the selected dispatcher. Valid allowed redirects and TLS verification are not disabled. Electron request registrations retain their original filters and callbacks, while clearing a caller's listener cannot clear the deny policy.

Blocking records contain only time, mechanism and hostname in the isolated Harness home's `logs/network-policy-blocks.jsonl`. The log has a best-effort 1 MiB cap; concurrent records can exceed that boundary slightly. Logging failure does not permit a request. Absence of log records alone is not proof of no networking.

## Isolation and setup

Defaults are an independent `~/.dsh-ium` Harness home and an independent `@lizy14/dsh-desktop-ium` application-data directory. `IUM_DSH_HOME` and `IUM_USER_DATA_DIR` permit explicit absolute overrides, but known original DSH roots and aliases into them are refused. The new default workspace is under the isolated home, not the original Documents workspace. Existing credentials, sessions and plugin state are not copied.

A first-launch editable profile seeds the non-DeepSeek `github-copilot` route. The initial model is only a starting value, not evidence of account access. Install a compatible Copilot sign-in plugin through Plugins, authenticate again and select an available model. Global shared agent skills may still be discovered through upstream conventions; data-directory isolation is not a filesystem sandbox.

`IUM_NPM_REGISTRY` overrides the registry for this process. Otherwise existing npm registry environment values, then the literal registry line from user/global npm configuration, are considered. Only the address is adopted; authentication fields are never copied. HTTPS is required except for loopback test registries. No corporate URL or machine path is baked into the public recipe.

## Limits

This module is not an operating-system firewall or a security boundary against arbitrary code running with the same user privileges. Malicious plugins can replace JavaScript functions or launch native code. Raw-IP connections without a meaningful authority, external programs, custom transports outside the guarded APIs, and Workers that deliberately discard preloads require separate environment-level controls. A remote service can also forward an otherwise allowed request; hostname filtering does not attest to that service's ownership or downstream behavior.

Do not change Defender, TLS validation or sandbox permissions to make a smoke test pass. Do not market the application-level results as a machine-wide ban. Installed startup, permitted provider operation and installer isolation require their own acceptance records.
