# Copilot Model Selection Spike

Date: 2026-09-01
Decision: **Conditional go.** Per-stage model selection is achievable with the supported API surface
the extension already uses, and needs no unsupported path. The condition is that two robustness
defects in the *existing* global selector be fixed first, because per-stage selection multiplies
their blast radius.

## Question and boundaries

The question is whether Kanban Pilot can control which language model runs a stage turn, and whether
that control can be made per stage — for example a cheaper model for Validation than for In Progress.

| Surface | Treatment in this spike |
| --- | --- |
| `workbench.action.chat.open<mode>` and its `modelSelector` option | Target. This is the command `ChatExecutor` already injects through. |
| `vscode.lm.selectChatModels` | Target, as the supported way to discover valid selector values. |
| Copilot Chat's own model picker UI | Observed only, as the state the target mutates. |
| `github.copilot.chat.*` settings | Surveyed for a settings-based path. Not adopted. |
| Sending requests directly via `LanguageModelChat.sendRequest` | Out of scope. That is a different executor architecture, not model selection for the existing one. |

No provider, executor, setting, board behaviour, or user-facing workflow was changed by this spike.
The only files added are this document and a read-only probe with its test.

## Version and availability evidence

| Item | Observed value |
| --- | --- |
| VS Code CLI | `1.127.0`, commit `4fe60c8b1cdac1c4c174f2fb180d0d758272d713`, x64 |
| Kanban Pilot engine requirement | `^1.125.0` ([package.json](../../package.json)) |
| `@types/vscode` | `1.125.0` |
| GitHub Copilot Chat | **Not installed in this profile.** 27 extensions present, none matching `copilot`. |

The behavioural findings below were read from the workbench bundle of the installed 1.127.0 build
(`resources/app/out/vs/workbench/workbench.desktop.main.js`) and from the extension host bundle. They
are therefore verified for 1.127.0. The extension's `engines` floor is `^1.125.0`; no evidence was
gathered for 1.125.x or 1.126.x specifically, so the findings are not asserted for the whole
supported range.

Because Copilot Chat is not installed here, **no live turn was observed**. The claim that a pinned
selector changes the model that answers is established from the action's implementation, not from a
watched run. That distinction is deliberate and is the main residual uncertainty in this document.

## What the extension does today

A single global setting is already wired end to end. Nothing about it is per stage.

| Step | Location |
| --- | --- |
| Setting declared, `type: object`, default `{}` | [package.json:291-295](../../package.json#L291-L295) |
| Read once into `RunConfig` | [runManager.ts:224](../../src/chat/runManager.ts#L224), [runManager.ts:243](../../src/chat/runManager.ts#L243) |
| Passed to the executor as a `RunOptions` field | [runManager.ts:1235](../../src/chat/runManager.ts#L1235) |
| Spread onto the payload only when non-empty | [executor.ts:360-362](../../src/chat/executor.ts#L360-L362) |
| Board editor and `{id, vendor}` validation | [boardPanel.ts:521-528](../../src/board/boardPanel.ts#L521-L528), [boardPanel.ts:705-720](../../src/board/boardPanel.ts#L705-L720) |

At the `{}` default the key is omitted from the payload entirely, so the command applies no model of
its own and the turn runs on **whatever the chat widget's picker currently holds** — the user's last
manual selection. That is the current behaviour for every Kanban Pilot user who has not set the
value, which is the default.

## Finding 1 — the option is honoured, and it throws when it misses

The chat open action resolves `modelSelector` like this (deminified from the 1.127.0 bundle, names
shortened):

```js
let mode = opts?.mode ? widget.input.currentChatModesObs.get().findModeByName(opts.mode) : this.mode;
if (mode) { await this.handleSwitchToMode(mode, widget, ...); }

if (opts?.modelSelector) {
  const id = (await languageModelsService.selectLanguageModels(opts.modelSelector)).sort().at(0);
  if (!id) { throw new Error(`No language models found matching selector: ${JSON.stringify(opts.modelSelector)}.`); }
  const metadata = languageModelsService.lookupLanguageModel(id);
  if (!metadata) { throw new Error(`Language model not loaded: ${id}.`); }
  widget.input.setCurrentLanguageModel({ metadata, identifier: id });
}
```

Four things follow, and three of them are problems.

1. **It works.** The option is read and applied, so the answer to "can Kanban Pilot control the
   model" is yes, through the command the executor already calls.
2. **Mode is resolved first, then the model.** The model assignment happens *after*
   `handleSwitchToMode`, so a pinned selector wins over whatever model the resolved custom agent
   would otherwise have carried. This matters because [executor.ts:346-350](../../src/chat/executor.ts#L346-L350)
   sends the column's agent name as `mode`, so the two features interact on every run.
3. **An unmatched selector throws.** A stale id — a model the vendor retired, a typo, a value copied
   from another machine — makes the whole open-and-inject call reject. The failure is not "fell back
   to the default model"; it is a failed stage run. There is no fallback path in the action.
4. **An ambiguous selector resolves arbitrarily.** `selectLanguageModels` returns every match, and
   the action takes `.sort().at(0)` — a lexicographic sort of model identifiers, not a preference
   order. A `{vendor: 'copilot'}` selector silently picks one model by string ordering.

Finding 3 is the sharper of the two defects: it converts a settings typo into a run failure.

## Finding 2 — the supported discovery API is the same service

`vscode.lm.selectChatModels` is not merely an analogous API. In the extension host bundle it is
mapped straight onto the service method the chat open action uses:

```js
selectChatModels: (selector) => languageModelsService.selectLanguageModels(extension, selector ?? {})
```

So the two share one selector space, and **an `id` or `vendor` obtained from
`vscode.lm.selectChatModels()` is valid input to `modelSelector`.** The refinement flagged this link
as unverified; it is now verified for 1.127.0. Neither `vscode.lm` nor `selectChatModels` appears
anywhere in `src/` today, so this remains unused ground rather than a change.

Enumeration is also cheap and safe. The consent dialog documented in the API types is attached to
`LanguageModelChat.sendRequest`, not to `selectChatModels`, so enumerating models cannot prompt the
user or consume quota. `LanguageModelChat` exposes `id`, `vendor`, `family`, `version`, `name`, and
`maxInputTokens` — everything a picker UI would need.

## Finding 3 — the board's setting is narrower than the command

The action validates the selector with:

```js
name?: string, id?: string, vendor?: string, version?: string, family?: string, tokens?: number, extension?: object
```

The board rejects everything except `id` and `vendor` ([boardPanel.ts:705-720](../../src/board/boardPanel.ts#L705-L720)).
The notable casualty is **`family`**. The API types describe `id` as *opaque* and subject to change,
while `family` carries the recognizable values (`gpt-4o`, `gpt-3.5-turbo`). A user who wants "the
cheap one" is best served by a family selector, and the board currently will not accept one. This
also makes finding 1.3 worse: `id` is the field most likely to go stale, and it is one of only two
the board allows.

## Finding 4 — selection is widget state, not per-turn state

`setCurrentLanguageModel` mutates the chat widget's current model — the same state the user's picker
shows. It is not a per-request override that reverts.

This is the single most important constraint on per-stage selection. If Validation runs with a
cheap model pinned, the picker is *left* on the cheap model. The user's next hand-typed message in
that chat goes to whatever the last Kanban Pilot run selected. With one global setting this is
mostly invisible, because every run pins the same value. With per-stage selection it becomes a
visible surprise: the model silently differs depending on which card ran last.

Any per-stage implementation must therefore decide, explicitly, whether it restores the previous
selection after a run — and the action offers no mechanism for that, so it would have to be built.

## Finding 5 — no unsupported path is needed

`github.copilot.chat.*` settings were surveyed as a settings-based route. Nothing there offers
per-invocation model control; the Copilot-side settings govern the picker's own defaults, and
writing another extension's settings to steer a run would be both fragile across Copilot releases
and a poor fit for the ToS posture already established in
[docs/claude-chat-spike.md](claude-chat-spike.md). Since the supported `modelSelector` option works,
no unsupported path is recommended, and none is needed.

## Evidence matrix

| Question | Answer | Confidence |
| --- | --- | --- |
| Is `modelSelector` honoured? | Yes, on 1.127.0 | High — read from the shipped implementation |
| Does it take effect in a live Copilot turn? | Believed yes | **Medium — not observed; Copilot Chat is not installed here** |
| Are `selectChatModels` ids valid selector input? | Yes | High — same service method |
| Does enumeration cost consent or quota? | No | High — consent is on `sendRequest` |
| Does a bad selector fall back gracefully? | No, it throws | High |
| Is selection scoped to the turn? | No, it persists in the widget | High |
| Does it hold for 1.125.x–1.126.x? | Unknown | Not tested |

## Design for per-stage selection, on paper

The precedent is [agentNames.ts](../../src/chat/agentNames.ts), which already solves the identical
shape — per-column configuration with a global fallback, a resolver, and a board editor.

- A sparse column-keyed overrides type, mirroring `AgentNameOverrides`, keyed by the same seven
  columns, with values of the selector shape.
- Reuse of `COLUMN_FOR_STAGE`, including its existing rule that `split` inherits `refine`.
- A `resolveModelSelector(stage, overrides, globalSelector)` mirroring `resolveAgentName`, with
  precedence: per-column override → global `chat.modelSelector` → unset (omit the key entirely, as
  [executor.ts:360-362](../../src/chat/executor.ts#L360-L362) already does).
- A board settings kind by analogy with `agentNames` and its column editor.
- Backward compatibility is straightforward: an existing global `chat.modelSelector` keeps working
  unchanged, because it is the fallback rung.

Sensible defaults would leave every column unset, so behaviour is unchanged until a user opts in.

## Risks

- **Run failure from a stale id.** Highest-severity issue found, and it exists today with the global
  setting. Per-stage selection multiplies the number of values that can go stale.
- **Picker state leakage** (finding 4) — a usability problem that only appears once selectors differ
  per stage, which is exactly what this feature introduces.
- **Version coupling.** `modelSelector` handling is workbench-internal behaviour, verified on one
  build. It is a documented command option, not a private API, but its throw-on-miss behaviour is an
  implementation detail that could change.
- **Availability varies by machine.** Models depend on the user's Copilot plan and sign-in state, so
  a selector valid for one user is a run failure for another sharing the same workspace settings.

## Smallest safe follow-up plan

Ordered. The first two are independent of whether per-stage selection is ever built, and the
recommendation is to do them regardless.

1. **Make a missed selector non-fatal.** Catch the `No language models found matching selector`
   rejection at the injection boundary in `executor.ts` and either fall back to an unpinned turn
   with a surfaced warning, or fail the run with a message naming the setting. Today the user gets
   an opaque failed stage.
2. **Widen the board's selector validation to `family`** (and optionally `version`), matching what
   the command accepts, so users can pin a portable value instead of an opaque id.
3. **Add model discovery to the board settings surface**, using `vscode.lm.selectChatModels` to
   populate a picker rather than asking users to type an opaque id. Enumeration is consent-free, so
   this is safe to do eagerly.
4. **Then implement per-stage selection** on the `agentNames` pattern above, with an explicit
   decision recorded on picker-state restoration (finding 4).
5. **Confirm on a machine with Copilot Chat installed** that a pinned selector visibly changes the
   answering model, closing the one medium-confidence row in the evidence matrix.

Items 1, 2, and 5 are filed as follow-up tasks from this run. Items 3 and 4 are the feature proper
and should be scoped only after item 5 confirms the mechanism live.

## Probe

[src/spike/chatModelProbe.ts](../../src/spike/chatModelProbe.ts) enumerates visible models and reports
selector ambiguity, throw-on-miss, and the board/command field gap.
[src/test/chatModelProbe.test.ts](../../src/test/chatModelProbe.test.ts) runs it in the existing
extension-test job. The probe opens no chat, submits no turn, and is not referenced from
`extension.ts`. It resolves normally on a host with no chat provider, which is the case in this
workspace and in CI.
