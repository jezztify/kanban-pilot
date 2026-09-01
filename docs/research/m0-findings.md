# M0 Spike — Findings

**Run:** 2026-08-13 · VS Code **1.133.0** (darwin-arm64), headless via `@vscode/test-cli`
**Probes:** [`src/spike/probes.ts`](../../src/spike/probes.ts) · [`src/test/m0.spike.test.ts`](../../src/test/m0.spike.test.ts)
**Reproduce:** `npm run compile-tests && npx vscode-test`

> **Update 2026-08-13 (fourth interactive run — M0 closed):** the exclusion mitigation is
> validated, with filesystem confirmation, not just a conversational reply. See finding 12 and
> §Remaining work. **This closes M0.**
>
> **Update 2026-08-13 (third interactive run):** R10 is confirmed and its root cause found —
> findings 10–11 below. It is **not** conversational carryover; it is a built-in Copilot tool
> that persists across sessions by design.
>
> **Update 2026-08-13 (second interactive run):** the live probes landed — findings 7–9. The
> first interactive run was invalid: it gated injections on the active-tab assertion that
> finding 1 proves impossible, refusing 20/20 with no model call. Fixed by detecting misroutes
> via per-session codewords instead.
>
> **Caveat:** findings 1–6 come from a headless host with no Copilot sign-in
> (`[AgentHost] No token resolved`); they are workbench-level behaviour that does not depend on
> auth. Findings 7–11 come from a signed-in Extension Development Host against `gpt-5.6-luna`.

---

## Results

| # | Question | Answer |
| --- | --- | --- |
| 1 | **R11** — is a chat session identifiable from `Tab.input`? | **NO** |
| 2 | Is the tab *label* a usable fallback? | **NO** (but not for the reason first recorded) |
| 3 | Exact id of the mode-scoped open action | `workbench.action.chat.openagent` |
| 4 | Does `vscode.open` honour a derived session URI? | **YES** |
| 5 | Is reopening a session idempotent? | **YES** |
| 6 | Does any command target a session directly? | **NO** |
| 7 | Does `blockOnResponse` wait for the turn? | **YES** |
| 8 | **Leakage** — how often does a prompt land in the wrong session? | **0 / 20** |
| 9 | Does the injection result expose a session identity? | **YES** — stable within, distinct between sessions |
| 10 | **R10** — does `newChat` clear a session, or fail open? | **FAILS OPEN — confirmed** |
| 11 | **R12** — is there a cross-session leak vector independent of session identity? | **YES — confirmed**: built-in `memory` tool |
| 12 | Does `toolsExclude` actually stop it? | **YES — confirmed on disk**, blocks the write, not just recall |

---

### 1 — R11: `Tab.input` is fully opaque

A chat editor's `Tab.input` is a minified class with **no readable properties anywhere on its
prototype chain**:

```
[group 0] "Chat" (active)
    input type: cg
    props: (none — fully opaque)
```

The shallow probe (`Object.keys`) returning `[]` could have been prototype getters, so this was
re-run as a full walk of the prototype chain. It is genuinely empty. There is no `uri`, no id,
nothing correlatable to a session.

### 2 — Labels are conversation-derived, not stable identifiers

**Corrected after the first interactive run.** The headless probe saw every tab labelled
`"Chat"` and concluded labels are always identical. That was an artifact of empty sessions. In a
signed-in host with real conversations, tabs are titled from their content — an actual run
observed `"Chat"`, `"hi"`, and `"Tesa test request"` as active-tab labels.

Labels are still unusable as the §6.9 identifier, but for a different reason: they are
**auto-generated from the conversation, mutate as it develops, are not unique, and are
user-renamable**. A brand-new session shows `"Chat"`, so two freshly-opened task sessions remain
indistinguishable at exactly the moment binding matters most.

### 3 — The mode-scoped action id is lowercase

`getOpenChatActionIdForMode()` builds `workbench.action.chat.open${mode.name}`, and the runtime
registry resolves that to **`workbench.action.chat.openagent`** — all lowercase, alongside
`openask` and `openedit`. The PRD's guess of `openAgent` was wrong.

### 4 — Derived session URIs work

Opening two derived URIs non-preview produces **two distinct tabs**:

```
vscode-chat-session://local/a2FuYmFuLXBpbG90LVNQSUtFLUE   (kanban-pilot-SPIKE-A)
vscode-chat-session://local/a2FuYmFuLXBpbG90LVNQSUtFLUI   (kanban-pilot-SPIKE-B)
```

VS Code treats them as distinct resources. The derivation in §6.7/§8.5 is sound.

### 5 — Reopening is idempotent

Open A → 1 tab. Open B → 2 tabs. **Reopen A → still 2 tabs.** A's existing tab is refocused
rather than forked, which is what makes `Continue` able to resume a conversation.

### 6 — No command targets a session

All three candidates reject a session resource, across six argument shapes each:

| Command | Result |
| --- | --- |
| `…chat.openSessionInEditorGroup` | throws `Cannot read properties of undefined (reading 'toString')` for every shape except `{ resource }`, which silently does not target |
| `…chat.openSessionInNewEditorGroup` | identical |
| `…chat.openNewChatSessionInPlace.local` | `Invalid chat session position argument` — wants a position, not a session |

### 7 — `blockOnResponse` is honoured

Same prompt, same session, with and without the flag:

| | Elapsed |
| --- | --- |
| `blockOnResponse: true` | **2754 ms** |
| omitted | **19 ms** |

It resolves with a populated `IChatAgentResult`: `timings`, `metadata.promptTokens` /
`outputTokens`, `toolCallRounds`, `resolvedModel` (`gpt-5.6-luna`), and
`details: "GPT-5.6 Luna • 0.5 credits"`. §6.2's primary completion signal is real, and richer
than assumed — token counts and cost are available per run.

### 8 — Zero leakage across 20 interleaved turns

Two sessions were seeded with private codewords (`ALPHA` / `BRAVO`), then alternated for 20
turns, each asked to recall *its own* codeword. Recall depends on conversation history, so a
wrong codeword is positive evidence of a misroute.

```
correct codeword:  20
wrong codeword:     0
no line written:    0
```

Turn times of 6–21 s confirm these were real model calls. **This is the M0 gate, and it passed.**

It also carries a second result the probe was not designed for: each session held its own
codeword across ten interleaved turns, which is **direct evidence that derived-URI binding
delivers real per-task context isolation** — G6 demonstrated, not just argued.

### 9 — The injection result carries a `sessionId`, and it's a usable identity

`metadata.sessionId` came back as a UUID — Copilot's conversation id, not our derived
`LocalChatSessionUri` id. `Probe session identity` alternated two sessions across five turns and
confirmed it is **stable within a session and distinct between sessions**:

```
IDENT-A: 1 unique id(s) — b6e347b5-4fa2-47a8-8312-5462b58cabd8
IDENT-B: 1 unique id(s) — b793dc27-12bb-481a-805d-e04105c0ee47
```

That makes it usable as an **automatic post-injection misroute detector** — record it on a
task's first run, compare on every later one, flag a mismatch without needing an operator to
notice a stray transcript. Materially strengthens §6.9, which otherwise assumed no automatic
detection was possible. See §6.9 for the mechanism.

### 10–11 — R10 confirmed; root cause is R12, Copilot's built-in memory tool

`Probe newChat clearing` v3 removed both of the earlier confounds — a fresh, never-before-used
session id and a runtime-generated codeword — and got a clean, interpretable result:

```
session (fresh, first use): SPIKE-RESET-7hrzhj
seed:  session=37083152-...  reply="I'm updating the saved codeword now.\n\nok"
invoking workbench.action.chat.newChat …
probe: session=1082509f-...  reply="KP7HRZHJ"
tools used answering: (none)
```

The session id changed, and the session had never existed before — so this cannot be stale
history in a reused tab, and cannot be the agent finding a literal string in source (v1's
confound). **The codeword still came back.** That is R10, confirmed.

A second thing this run exposed: **the tool-call detector has a blind spot.** It reported
`(none)`, but the seed reply narrates the tool running — *"I'm updating the saved codeword
now."* `toolCallsOf()` only reads `metadata.toolCallRounds[].toolCalls`, and whatever this tool
is, its invocation doesn't surface there in a form the extraction catches. The probe's own
instrumentation cannot be trusted to rule out tool use.

The root cause arrived as direct evidence from the user, not from a probe: a screenshot of VS
Code's **Configure Tools** picker, showing a built-in tool named **`memory`** under the built-in
`vscode` toolset — *"Manage persistent memory across conversations"* — alongside
`resolveMemoryFileUri`, with the picker itself stating *"The selected tools will be applied
globally for all chat sessions that use the default agent."*

**R12 is promoted from hypothesis to confirmed.** R10's mechanism is not conversational
carryover — it is a tool scoped to the user rather than the session, invisible to and
unpreventable by anything session-identity-based. `newChat`, a fresh session id, none of it
matters, because the content was never part of the session's state to begin with.

---

## What this means

The probes separate two things the PRD had conflated:

| | Status |
| --- | --- |
| **Binding** (open a specific session) — the *write* path | ✅ **Works.** Deterministic, stable, idempotent |
| **Verification** (know which session is active) — the *read* path | ❌ **Impossible.** No API exposes it |

**G6 is achievable exactly as designed.** One chat per task, derived from the task id, is
delivered by §6.7 and confirmed by probes 4 and 5.

**§6.9's fail-closed protocol is not buildable.** It required asserting the active tab before
injecting; nothing supports that assertion. Prevention-by-verification is off the table.

**The G6-versus-chat-UI fork is NOT triggered.** §6.9 predicted that an R11 failure would force
a choice between G6 and the visible chat UI. That prediction was wrong, because it assumed
unverifiable meant unbindable. Binding works; only the assertion is lost. Both G6 and the chat
UI survive.

### Consequence for the design

- §6.9 must be rewritten: no pre-assertion, therefore **no fail-closed guarantee**.
- Misroute handling becomes **entirely post-hoc**: the `task:` receipt (which validates that
  work landed in the right *file*), the `[kanban-pilot TASK-nnn]` banner (human-visible), and now
  automatic `metadata.sessionId` comparison (finding 9) rather than purely user-triggered repair.
- Self-contained prompts move from defence-in-depth to **load-bearing** — they are what keeps a
  misroute's blast radius at context pollution rather than wrong work.
- The "<5% injection refusals" metric is void — there are no refusals without an assertion.
- Measured leakage is **0/20**, so the narrow-window approach holds in practice and §8.2 stays
  closed: chat injection survives M0.

**A second, independent consequence from findings 10–11:** §6.8's stage-boundary design assumed
the threat was conversational carryover, and built layered mitigations for that. The confirmed
mechanism is different — a memory tool scoped to the user, not the session — and none of those
layers touch it. §6.8 now leads with **layer 0: deny the memory tool on every injection**,
ahead of and independent of session reset. This also generalizes past the stage boundary:
because the tool isn't session-scoped, it is a potential leak vector **between different tasks**
too, not just between a task's own refine and develop turns — so layer 0 is now framed as
protecting G6 as much as §6.8.

---

## Remaining work

Needs a signed-in Copilot host. Launch the Extension Development Host (F5) and run from the
palette under **Kanban Pilot Spike**:

| Command | Answers | Status |
| --- | --- | --- |
| `Probe blockOnResponse` | Terminal-state resolution and return shape (§6.2) | ✅ Done — finding 7 |
| `Probe interleave leakage (20 runs)` | Misroute rate (§6.9) | ✅ Done — finding 8, **0/20** |
| `Probe session identity` | Is `metadata.sessionId` a usable session identity? | ✅ Done — finding 9, stable/distinct |
| `Probe newChat clearing (R10)` | Does `newChat` clear, or fail open? | ✅ Done — finding 10, **confirmed failing** |
| `Probe memory tool exclusion` | Does `toolsExclude: ['memory','resolveMemoryFileUri']` (§6.8 layer 0) actually block the leak? | ✅ Done — **works**, with filesystem confirmation |

**M0 is closed.** The exclusion probe passed:

```
codeword: KPORLA90
seed:  reply="ok"
invoking workbench.action.chat.newChat …
probe: reply="NONE"

EXCLUSION WORKS. The memory tool did not leak the codeword when denied.
```

That alone would have been enough, but the same output carried a bonus piece of evidence: a
stale screenshot in the same session showed the memory tool's actual transcript from an
**earlier, unrelated run** — codeword `KP1VXHIW`, with visible tool calls `Read memory` →
`Updated memory file codeword.md`. Different codeword, different run, but it named the exact
file the tool writes — which turned this from "the reply says NONE" into something checkable
on disk.

**Filesystem confirmation:**

```
~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/memory-tool/memories/codeword.md
  contents: "- Codeword: KP1VXHIW."
```

The file's content is the **old** codeword (`KP1VXHIW`), not this run's (`KPORLA90`) — direct
proof that exclusion blocked the *write*, not merely the read-back. And its location resolves
the residual worry from open question 9 (§10 M0 detail table) about indirect discovery: it sits
under VS Code's global application-support directory, entirely outside any workspace folder.
Refine's `toolsInclude: ['codebase', 'search', 'usages']` (§6.6) is workspace-scoped by
construction — those tools cannot reach it regardless of `toolsExclude`. A parallel check of the
**per-workspace** memory store (VS Code also keeps one per workspace, under
`workspaceStorage/<hash>/GitHub.copilot-chat/memory-tool/`) found the entry for this exact repo
empty — no leaked content there either.

**R12 is resolved**, not just confirmed. Both halves of the concern — does exclusion actually
stop the write, and can the same content be reached some other way — now have direct evidence,
not inference from a chat reply.
