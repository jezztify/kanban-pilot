# Copilot Context Compaction

Date: 2026-09-04
Task: TASK-014 — "trigger auto compact when a certain context window threshold% has been reached"

Decision: **Conditional go for native automatic compaction; no-go for explicit task-session `/compact`**.

## Compatibility evidence

Kanban Pilot supports VS Code `^1.125.0`. The local VS Code test builds were inspected rather
than assuming that an experimental setting was stable:

| VS Code | GitHub Copilot Chat | Native settings | Explicit compact target |
| --- | --- | --- | --- |
| 1.133.0 | 0.61.0 | Both registered; threshold is optional and ratio-capable | Not exposed |
| 1.136.1 | 0.64.1 | Both registered; threshold is optional and ratio-capable | Not exposed |

The registered native settings are
`github.copilot.chat.summarizeAgentConversationHistory.enabled` and
`github.copilot.chat.summarizeAgentConversationHistoryThreshold`. The threshold declaration
allows an unset value and also supports Copilot's separate absolute-token form. Kanban Pilot
accepts only a ratio greater than `0` and at most `1`, so `0.8` means 80% of the active model
context window.

The installed `github.copilot.chat.compact` implementation delegates to a focused
`workbench.action.chat.open` invocation with `/compact`; it accepts no supported
`vscode-chat-session://local` target. Opening a task session and then issuing that command would
only narrow a focus race, not establish a supported target contract. Kanban Pilot therefore
reports explicit compaction as unsupported and never invokes the focus-only command. The
production executor has a dependency-injected target seam that remains unset until a supported
session-targeted API exists.

## Shipped policy

`chat.autoCompact` is off by default. When enabled, the adapter validates the ratio, checks
runtime native-setting registration and explicit-value conflicts, and writes only missing native
values at workspace scope. Copilot owns threshold monitoring and history summarization. Kanban
Pilot does not reconstruct live usage from transcripts, hook events, or completed-turn token
metadata, and a user-visible context dashboard is deferred until a supported live usage source
exists.

Native settings are experimental, so no minimum Copilot version is promised beyond the tested
build evidence. Missing settings, incompatible experimental behavior, invalid values, explicit
conflicts, and failed operations produce bounded status while normal task execution and session
identity remain usable. Native setting changes are rechecked on configuration changes and on the
next task run; task chat bindings are never reset.
