# Upstream controls and discussions

Reviewed on 2026-11-07 against release `dsh-v0.2.2-rc.1` (`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`) and the then-public master (`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`). These are different source trees. This project pins the release, not the floating branch.

No reviewed upstream option disables all DeepSeek network access, all telemetry and both Desktop update paths together. The controls below are independent.

| Mechanism | Upstream control | Important boundary |
|---|---|---|
| Session-feedback OTel | `DSH_TELEMETRY_DISABLED` or `session-telemetry-otel.mode=DISABLED` | The environment opt-out only disables the Session telemetry row, not every mechanism below. Any nonempty value of the opt-out variable counts, including `0`/`false`. |
| Session log attached to model requests | `session-log-deepseek.enabled=false` | Separate from OTel; also exposed by a General settings switch. |
| Plugin inventory attached to requests | `plugin-package-inventory-deepseek.enabled=false` | Separate default-on request contribution. |
| Desktop product analytics | `product-analytics.enabled=false` | Upstream describes no user-facing control. Stops new collection; already queued exporter data is a separate concern. |
| Ordinary update download/install | Upstream already sets `autoDownload=false` and `autoInstallOnAppQuit=false` | Does not stop metadata checks. |
| Ordinary update checks | No supported off switch found | Poll interval/backoff and channel settings are not disable controls. |
| Mandatory update policy | Omit policy metadata in a suitable custom build | Independent startup/periodic query; not controlled by the ordinary feed. |
| Models, account, search and other services | Individual providers/plugins | No reviewed application-wide domain-deny switch. |

Current boot rules treat most `DSH_*` variables as trusted launch-environment inputs; do not assume they can be placed in a discovered `.env` file. Ium uses an explicit deployment overlay instead of relying on that opt-out variable.

Source references:

- [Session telemetry opt-out construction](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/app-boot/src/profile-context.ts#L39-L58)
- [Base telemetry defaults](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/base/cordis.patch.yml#L205-L232)
- [Session-log configuration](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-log-deepseek/README.md#configuration)
- [Plugin inventory contribution](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/plugin-package-inventory-deepseek/src/index.ts)
- [Product analytics configuration](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/product-analytics/README.md#use-this-package)
- [Ordinary update schedule](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/desktop/src/update-schedule.ts)
- [Desktop settings](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/desktop/src/settings-file.ts)
- [Mandatory policy](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/desktop/src/mandatory-update-policy.ts)

## Existing public feedback

Upstream exposes Discussions; an empty Issues search is not evidence that nobody raised these concerns. At review time the following discussions were open, and no response marked with a maintainer role or confirmed resolution was found. Discussion status alone is not a code audit, so the current sources were checked separately.

- [#9927](https://github.com/deepseek-ai/deepseek-harness/discussions/9927): Session-log and plugin-inventory fields remain despite `DSH_TELEMETRY_DISABLED`; requests clearer controls and safer defaults.
- [#10604](https://github.com/deepseek-ai/deepseek-harness/discussions/10604): `--dump-config` omits the startup telemetry opt-out layer. This is a display/composition discrepancy, not proof that the runtime opt-out does nothing.
- [#11754](https://github.com/deepseek-ai/deepseek-harness/discussions/11754): downstream build-time identity, update feed and default-bundle configuration.
- [#8527](https://github.com/deepseek-ai/deepseek-harness/discussions/8527) and [#7725](https://github.com/deepseek-ai/deepseek-harness/discussions/7725): concerns about default Session-log reporting. User-reported leakage details are not treated here as independently verified findings.

Ium does not assume these requests are solved merely because a channel selector or one telemetry flag exists. It disables the known producers, removes update initialization in the work build, and tests application transport enforcement separately.
