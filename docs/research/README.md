# Research

Dated decision records — spikes, findings, and smoke validations. Each one answers a question that
was open at the time and records the decision it reached. They are **not** maintained specs: a
record describes what was true on its date, and a later record may supersede it. For the living
specification, see [PRD.md](../PRD.md); for how the shipped product behaves, see the
[user documentation](../../README.md).

| Document | Date | Decision |
| --- | --- | --- |
| [M0 spike findings](m0-findings.md) | 2026-08-13 | **M0 closed.** Command/API probe results against VS Code 1.133.0, including the tool-exclusion mitigation. |
| [Claude chat driving spike](claude-chat-spike.md) | 2026-08-15 | **No-go** for driving the Claude Code panel as a second in-process executor. Conditional go for a later process-backed Agent SDK/CLI executor. |
| [Legacy remote tunnel smoke](remote-tunnel-smoke.md) | 2026-08-25 | **Unavailable** — no authenticated second client or active host tunnel in the environment. |
| [Browser-view chat proxy spike](browser-chat-proxy-spike.md) | 2026-08-26 | **Conditional go.** No-go for full transcript mirroring; conditional go for an agent-emitted activity feed. |
| [Copilot model selection spike](copilot-model-selection-spike.md) | 2026-09-01 | **Conditional go.** Per-stage model selection is achievable on supported API surface, once two defects in the global selector are fixed. |
| [Copilot response streaming spike](copilot-response-streaming-spike.md) | 2026-09-01 | **Conditional go.** Response content is reachable as ordinary files, but it is a lagging tail (5–50 s), undocumented and unversioned. |
| [Copilot hook feed design](copilot-hook-feed-design.md) | 2026-09-01 | **Conditional go, at reduced value.** Hooks deliver turn and tool events at near-zero lag, but the editor never dispatches `PermissionRequest`. |

## Known stale links

Two records point at files that no longer exist in the repository. Both predate the move into this
folder and are left as written rather than silently rewritten:

- [`m0-findings.md`](m0-findings.md) references `src/spike/probes.ts` and `src/test/m0.spike.test.ts`.
- [`remote-tunnel-smoke.md`](remote-tunnel-smoke.md) references `hosted-smoke.md`.
