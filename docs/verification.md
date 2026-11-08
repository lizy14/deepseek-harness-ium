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
| Packaged CLI acceptance | Exact executable/ASAR, policy before carrier imports, identity, final profile/dump layers, guarded package-manager metadata/install paths, argv/stdin/exit/interrupt behavior | An earlier GUI acceptance also covers a changed CLI |
| Data-preserving handover | Compatible complete cold copy, effective ACLs, history/attachment identity and byte checks, retained originals, account-state-aware rollback, post-switch observation | Arbitrary old/new schemas or rotating credential snapshots are interchangeable |
| Installer qualification | Isolated install/upgrade/uninstall tests that leave the original application/data untouched | Organization approval of unsigned executables |

## Offline native test

The fixture uses a fixed loopback rejecting proxy and denies external Chromium DNS. Node has an independent fail-safe below the policy under test. The proxy never forwards. Allowed requests are loopback only; testing a prohibited hostname must never actually contact it.

The native runner uses a separately downloaded, checksum-verified Electron distribution, not the existing installed DSH. It rejects stale result directories. A process exit without the result file, a timeout or a startup crash is a failure, even if a wrapper command itself exits successfully. The module hash must identify the exact tested source or compiled policy.

## First-use application checks

Use temporary fixture data, not a copy of real credentials:

1. With no credentials or third-party plugins, reach the main UI and Plugins installation controls without a DeepSeek login requirement.
2. Exercise the built-in provider authorization with an isolated simulated device flow and send a local mock-provider request. If optional sign-in UI plugins are part of the target deployment, test them separately; they are not a prerequisite for the built-in flow. Verify the allowed path remains usable without real account-policy writes.
3. Restart and preserve the selected provider/model without onboarding again.
4. Supply a valid synthetic DeepSeek grant and verify no profile, balance, bonus or native Platform page request occurs.
5. Attempt to re-enable account/providers in a user patch; the final deployment overlay must still win.
6. Open the Ium Host through an ordinary browser as well as native Desktop. A local preview notice is not a DeepSeek authentication gate.
7. Reject malformed stored credentials with an actionable local error; do not silently delete data or fall back to the original installation.

Assert producer call counts as well as transport denial. A guard stopping repeated requests is useful protection, but is not evidence that the producers were disabled correctly.

## Current qualification status

Offline regressions and the native Electron 44.7.0 policy component smoke have passed from a non-synchronized build directory, including actual Chromium `ERR_BLOCKED_BY_CLIENT` cancellations and zero forbidden proxy/fail-safe attempts. The earlier synchronized-directory attempts exited before JavaScript with `0x80000003`; those failures remain in the local evidence and are not counted as passes. No Defender, TLS or application sandbox protection was disabled.

A targeted local Windows CLI smoke has also exercised the new executable/ASAR entry and generated batch launcher: version/help, normal/default/schema dumps, final deployment precedence, malformed user-patch refusal, isolated identity, binary stdin/Unicode argv, exit status, and forbidden hosts/redirects behind an independent offline fail-safe. It does not cover native Ctrl+C/Break delivery, real managed-pnpm operations, provider login, or a new candidate's complete GUI. Local operator receipts are kept outside the public source tree.

Complete packaged Desktop/CLI acceptance and signed/installed qualification remain separate and are not yet claimed for a newly changed recipe. Local deployment success on an earlier exact candidate does not qualify a later bootstrap, CLI or artifact hash. Real user migration records and credentials remain private; the public checks use synthetic data. A clean Windows CI run remains useful as an independent check; activating the prepared template requires the repository owner's appropriate GitHub authorization.
