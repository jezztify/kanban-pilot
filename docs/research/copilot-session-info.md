# Copilot session context occupancy investigation

**Task:** TASK-001  
**Date:** 2026-09-06  
**Decision:** No supported source currently provides exact live context occupancy for a Copilot task session. The local OpenAI-compatible endpoint provides model capacity, not session occupancy.

## Copilot code evidence

| Source | Observed value | Scope and freshness | Exact live occupancy? |
| --- | --- | --- | --- |
| `src/chat/sessionUri.ts` | Deterministic `vscode-chat-session://local/<base64url>` binding from task/set id; persisted `chat` wins unless it is the Copilot UUID | Session identity; stable across reopen/reload | No. It identifies the write target but exposes no usage read API |
| `src/chat/executor.ts` | Sends `blockOnResponse: true`; awaits terminal result; returns only `metadata.sessionId` as `ExecutorResult.sessionId` | Per completed turn; Copilot UUID, not the local URI | No. It is identity only |
| `src/spike/chatModelProbe.ts` | `LanguageModelChat.maxInputTokens` | Model capacity at enumeration time | No. It is a limit, not current prompt/history occupancy |
| `src/spike/chatTranscriptProbe.ts` | Presence, size, and mtime of workbench/Copilot JSONL records; content is deliberately not read | File metadata, not a token count; changes asynchronously | No. File size cannot represent token occupancy reliably |
| `src/chat/contextCompaction.ts` | Experimental native enable/threshold settings; Copilot owns threshold monitoring and summarization | Copilot-managed session behavior; threshold may be a ratio or absolute token setting | No. No counter or current value is returned |

The existing flow is: `sessionIdForTaskBinding()` derives the local session, `vscode.open` focuses it, and `workbench.action.chat.openagent` receives the prompt and attachments. The runtime result observed by the M0 probe contains per-turn `metadata.promptTokens` and `metadata.outputTokens`, plus model and cost details, but the production executor type retains only `metadata.sessionId`. Those counts describe one completed request; they are not documented or observed as a cumulative current-context counter, remaining budget, or percentage. The returned Copilot UUID is persisted for identity/misroute detection and is intentionally never used to construct the reopen URI.

## Compatibility evidence

The extension supports VS Code `^1.125.0`. The signed-in M0 probe ran against VS Code 1.133.0 and `gpt-5.6-luna`; it confirmed `blockOnResponse`, stable Copilot session identity, and per-turn token metadata. The compaction investigation checked VS Code 1.133.0/Copilot Chat 0.61.0 and VS Code 1.136.1/Copilot Chat 0.64.1. Both registered the experimental native compaction settings, but neither exposed a supported session-targeted compact or usage API. The executor tests verify the local binding, command order, `blockOnResponse`, and separation of the Copilot UUID from the local session URI. Model-probe and compaction tests verify capacity enumeration and the no-overwrite native-setting policy.

## OpenAI-compatible endpoint probe

Read-only probes were run on 2026-09-06; no completion, prompt, transcript, or credential was sent:

- `GET http://localhost:8001/v1/models` returned `200` from `llama.cpp`. The model is `qwen3.8-27b`; metadata reports `n_ctx: 86016` and `n_ctx_train: 262144`.
- `GET http://localhost:8001/v1` returned `404 File Not Found`.
- `GET http://localhost:8001/v1/usage` returned `404 File Not Found`.

`n_ctx` is a server/model capacity setting and `n_ctx_train` is a training-context value. Neither is current usage. The OpenAI-compatible surface has no session identifier corresponding to Copilot's private chat and no observed live usage route. A normal completion response may report usage for that one request, but submitting one was explicitly out of scope and would still not expose Copilot's existing session history.

## Verdict and recommendation

- **Copilot:** current tokens: unavailable; maximum: model metadata only; percentage: unavailable. Do not add a live context dashboard from transcript size or accumulated turn totals.
- **Endpoint:** current tokens: unavailable; maximum: `n_ctx` capacity only; percentage: unavailable. It cannot inspect Copilot's private session.
- **Fallback:** retain native Copilot auto-compaction as the supported threshold action, or expose clearly labeled per-turn telemetry if a future implementation deliberately expands the result type. Any ratio computed from one turn's tokens divided by `maxInputTokens`/`n_ctx` must be labeled an estimate, never live occupancy. Exact reporting requires a future supported Copilot usage/session API or instrumentation at the model-serving boundary.

All probes were GET-only and avoided sensitive content. Future transcript or private-extension-storage scraping would be brittle, privacy-sensitive, and outside the supported API boundary.

## Implementation record

- Changed only this research document and the required task progress/receipt log entries.
- Checked source evidence, tests, compatibility notes, and endpoint response shapes.
- No product code, tests, configuration, endpoint behavior, transcripts, or task frontmatter was changed.
