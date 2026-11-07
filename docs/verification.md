# Verification and release limits

Each stage answers a different question. No stage substitutes for the ones below it.

| Stage | Required evidence | Does not establish |
|---|---|---|
| Source preparation | Exact upstream commit, reviewed patch diff, declared overlay hashes and source input digest | A functioning application |
| Offline policy tests | Independent external-network fail-safe, allowed loopback behavior, blocked hosts/redirects/proxy reuse, no leaked request data | Real Electron API behavior |
| Upstream focused tests | Update startup/focus/resume/manual paths, application identity, package metadata, Host preload ordering and unchanged upstream cases | Packaged native startup |
| Artifact and aggregate build | Complete artifacts followed by aggregate semantic checks | A valid installer or runtime payload |
| Native component smoke | Matching stock Electron, fresh isolated output, exit 0, PASS JSON, exact module hash, zero forbidden proxy attempts and fail-safe violations | The complete Desktop UI or real provider login |
| Packaged inspection and upstream smoke | Independent identity, no update feed/policy, required compiled modules, matching final overlay, runtime/ASAR/native/Office checks | Installed GUI and uninstall safety |
| Complete Desktop acceptance | Fresh home, usable Plugins/Models pages, no account gate, zero built-in DeepSeek attempts, allowed provider operation and restart | Every arbitrary external program is contained |
| Installer qualification | Isolated install/upgrade/uninstall tests that leave the original application/data untouched | Organization approval of unsigned executables |

## Offline native test

The fixture uses a fixed loopback rejecting proxy and denies external Chromium DNS. Node has an independent fail-safe below the policy under test. The proxy never forwards. Allowed requests are loopback only; testing a prohibited hostname must never actually contact it.

The native runner uses a separately downloaded, checksum-verified Electron distribution, not the existing installed DSH. It rejects stale result directories. A process exit without the result file, a timeout or a startup crash is a failure, even if a wrapper command itself exits successfully. The module hash must identify the exact tested source or compiled policy.

## First-use application checks

Use temporary fixture data, not a copy of real credentials:

1. With no credentials or third-party plugins, reach the main UI and Plugins installation controls without a DeepSeek login requirement.
2. Install a compatible test Copilot plugin, complete a simulated device flow and send a local mock-provider request. Verify the allowed path remains usable.
3. Restart and preserve the selected provider/model without onboarding again.
4. Supply a valid synthetic DeepSeek grant and verify no profile, balance, bonus or native Platform page request occurs.
5. Attempt to re-enable account/providers in a user patch; the final deployment overlay must still win.
6. Open the Ium Host through an ordinary browser as well as native Desktop. A local preview notice is not a DeepSeek authentication gate.
7. Reject malformed stored credentials with an actionable local error; do not silently delete data or fall back to the original installation.

Assert producer call counts as well as transport denial. A guard stopping repeated requests is useful protection, but is not evidence that the producers were disabled correctly.

## Current qualification status

Offline regressions and the native Electron 44.7.0 policy component smoke have passed from a non-synchronized build directory, including actual Chromium `ERR_BLOCKED_BY_CLIENT` cancellations and zero forbidden proxy/fail-safe attempts. The earlier synchronized-directory attempts exited before JavaScript with `0x80000003`; those failures remain in the local evidence and are not counted as passes. No Defender, TLS or application sandbox protection was disabled.

Complete packaged Desktop acceptance and signed/installed qualification remain separate and are not yet claimed. A clean Windows CI run remains useful as an independent check; activating the prepared template requires the repository owner's appropriate GitHub authorization.
