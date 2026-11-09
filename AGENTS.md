# Ium contributor rules

This repository owns downstream patches, overlays, build tooling and tests, not a copy of upstream history.

- Keep `upstream.lock.json` pinned to a public immutable commit. Never publish from a floating branch or an unverified checkout.
- Keep this repository, build checkouts, caches, audit output and temporary artifacts outside OneDrive or other synchronized directories. Do not leave an old synchronized copy or compatibility junction behind when relocating.
- `.work/`, `local/`, caches, artifacts and machine configuration stay out of Git. Do not copy user profiles, credentials, Remote keys or enterprise authentication into this repository.
- Preserve the original upstream fork and existing installed applications. Ium needs an independent package/app identity, user-data directory, Harness home and optional OS protocol/command registrations.
- Keep work-device policy distinct from household deployment. Never commit or push actual organizational registry addresses, internal endpoints, tenant/account identifiers, machine paths or authentication; keep them only in ignored local configuration/environment. Public fixtures use reserved example domains.
- Block both `deepseek.com` and `deepseeksvc.com` including subdomains in the work edition. Disable built-in producers as well as requests. Do not substitute invalid endpoints and call that zero networking.
- Do not weaken Defender, TLS validation, signing checks or application sandbox permissions to make a build pass.
- State coverage accurately: application HTTP/Chromium enforcement is not an OS firewall for arbitrary external programs, malicious plugins or raw-IP/custom transports.
- Network tests must be offline. Install an independent fail-safe before tests involving blocked hostnames; no test may actually resolve or connect to a prohibited external host.
- A successful source test is not a packaged Desktop acceptance result. Preserve upstream runtime inventory and payload checks; withhold release claims when native smoke or packaging fails.
- Use dependency-free Node tooling here where practical. In confined Windows execution, subprocesses inherit stdio or write directly to files, not captured pipes.
- Read applicable upstream instructions before changing `.work/upstream`. Export only reviewed source patches and declared overlays; never stage the whole checkout.
- Publish only after reviewing the diff, testing the exact inputs and recording the commit/release metadata. Follow the user's active authorization and approval policy; never force-push or delete repositories to change the project model.
