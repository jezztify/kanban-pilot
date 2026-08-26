---
id: TASK-011
title: test failure
type: bug
state: in-progress
status: idle
position: 0
created: 2026-08-26T10:03:52Z
updated: 2026-08-26T10:10:20Z
pending_outcome: {"gate":"developToValidation","stage":"develop","result":"ok","runId":"r3dvkf4"}
chat: f28245aa-8b3e-41fe-9e26-f1b07907af6b
copilot_session_id: f28245aa-8b3e-41fe-9e26-f1b07907af6b
scope_hash: 818ac8f
chat_reset_required: false
---

## Request
```'
  1 failing
  1) Extension Test Suite
       defaults outbound turns to safe browser progress narration:

      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ ''
- `Treat the prompt's "Optional progress updates" section as required. Append a concise progress line after each meaningful phase of work, including investigation, editing, testing, and waiting for user action. Never include source, secrets, tokens, or absolute file paths.`

      + expected - actual

      +Treat the prompt's "Optional progress updates" section as required. Append a concise progress line after each meaningful phase of work, including investigation, editing, testing, and waiting for user action. Never include source, secrets, tokens, or absolute file paths.
      
  	at Context.<anonymous> (dist/test/extension.test.js:64:16)
  	at process.processImmediate (node:internal/timers:504:21)
```

## Refined

### Problem statement

The extension defines the safe browser-progress instruction in
`src/extension.ts` as `DEFAULT_OUTBOUND_PREAMBLE`, and its outbound transform
uses that value as the fallback. However, the contributed
`kanbanPilot.chat.outboundPreamble` setting in `package.json` currently has an
empty-string default. Because the registered setting value is present, it
overrides the `get` fallback and clean installations send outbound turns
without the required progress-narration instruction. This makes the existing
extension regression test fail with an actual empty string.

The fix must align the contributed default with the canonical preamble while
preserving the intentional empty-string opt-out and any user-provided custom
preamble.

### Acceptance criteria

- A clean configuration reports the exact `DEFAULT_OUTBOUND_PREAMBLE` text as
      the default value of `kanbanPilot.chat.outboundPreamble`; it is not an empty
      string.
- With no user override, every extension-initiated outbound turn receives the
      safe progress-narration instruction before its existing query, including the
      requirements to provide concise phase updates and never disclose source,
      secrets, tokens, or absolute file paths.
- An explicit empty-string setting continues to disable the preamble, and an
      explicit non-empty setting continues to prepend the user's custom text.
- The behavior remains limited to the extension's self-initiated turns and
      does not alter text typed directly by the user in Copilot Chat.
- The focused extension regression test and the relevant compile, lint, and
      full test checks pass without unrelated changes.

## Scope

- [ ] Update `package.json` so
      `contributes.configuration.properties.kanbanPilot.chat.outboundPreamble.default`
      contains the exact canonical preamble text from `DEFAULT_OUTBOUND_PREAMBLE`,
      including the escaped quoted section name required by JSON.
- [ ] Review `src/extension.ts` without changing its public contract: retain
      `DEFAULT_OUTBOUND_PREAMBLE` as the canonical fallback and preserve the
      existing trim, custom-value, and empty-string opt-out behavior in the
      outbound transform.
- [ ] Keep the regression coverage in `src/test/extension.test.ts` aligned
      with the manifest/default contract, including the exact default-value
      assertion and the safety-wording assertions; add only narrowly focused
      coverage if the implementation changes the seam needed to verify the
      explicit opt-out.
- [ ] Run the focused extension test plus `npm run compile-tests`,
      `npm run compile`, `npm run lint`, and the full `npm test` command; confirm
      the reported `actual: ''` failure is gone and no unrelated test regresses.
- [ ] Do not modify task state/frontmatter, user configuration, Copilot Chat
      input behavior, or generated artifacts as part of this fix.

## Log
- audit:state-change at:2026-08-26T10:03:57Z task:TASK-011 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T10:03:58Z task:TASK-011 from:idle to:running action:refine run:r0ojgjk note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T10:03:58Z task:TASK-011 stage:refine action:refine run:r0ojgjk note:"Started refine activity."
- progress run:r0ojgjk task:TASK-011 at:2026-08-26T10:05:28Z note:"diagnosed the outbound default mismatch and defined the focused fix"
- run:r0ojgjk task:TASK-011 stage:refine result:ok note:"2026-08-26T10:05:28Z — documented the manifest default mismatch, preserved opt-out behavior, and scoped focused verification"
- audit:status-change at:2026-08-26T10:06:07Z task:TASK-011 from:running to:idle action:receipt run:r0ojgjk outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T10:06:07Z task:TASK-011 stage:refine action:receipt run:r0ojgjk outcome:ok note:"2026-08-26T10:05:28Z — documented the manifest default mismatch, preserved opt-out behavior, and scoped focused verification"
- audit:state-change at:2026-08-26T10:06:15Z task:TASK-011 from:refine to:scoped action:apply-pending run:r0ojgjk outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-26T10:06:26Z task:TASK-011 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T10:06:31Z task:TASK-011 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T10:06:31Z task:TASK-011 from:idle to:running action:develop run:r3dvkf4 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T10:06:31Z task:TASK-011 stage:develop action:develop run:r3dvkf4 note:"Started develop activity."
- progress run:r3dvkf4 task:TASK-011 at:2026-08-26T10:10:07Z note:"aligned the outbound progress default and completed focused and full verification"
- run:r3dvkf4 task:TASK-011 stage:develop result:ok note:"2026-08-26T10:10:07Z — aligned the manifest default with the canonical preamble and verified compilation, lint, focused regression, and 356 full-suite tests"
- audit:status-change at:2026-08-26T10:10:20Z task:TASK-011 from:running to:idle action:receipt run:r3dvkf4 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T10:10:20Z task:TASK-011 stage:develop action:receipt run:r3dvkf4 outcome:ok note:"2026-08-26T10:10:07Z — aligned the manifest default with the canonical preamble and verified compilation, lint, focused regression, and 356 full-suite tests"
