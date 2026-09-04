# Optional Copilot hook feed

For lower-latency activity, Kanban Pilot can consume a manually configured Copilot Claude-compatible
hook. Hook entries arrive as events happen; transcript entries arrive later when Copilot flushes its
session transcript, and progress entries are coarse summaries written during a run. The hook feed is
read-only activity and does not replace either of those sources. Hook entries contain bounded
structural metadata rather than a Copilot transcript.

To enable it for one workspace, add the following to that workspace's `.claude/settings.local.json`.
Kanban Pilot does not write this file automatically. Replace each `<repo>` with the absolute path to
this repository: the hook's working directory defaults to the user's home directory, so relative
paths are not reliable.

```json
{
   "hooks": {
      "UserPromptSubmit": [
         { "matcher": "*", "hooks": [{ "type": "command", "timeout": 5,
            "command": "node \"<repo>/scripts/kanban-pilot-hook.mjs\" --spool \"<repo>/.kanban-pilot/.hook-spool.jsonl\"" }] }
      ],
      "PostToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "timeout": 5,
            "command": "node \"<repo>/scripts/kanban-pilot-hook.mjs\" --spool \"<repo>/.kanban-pilot/.hook-spool.jsonl\"" }] }
      ],
      "Stop": [
         { "matcher": "*", "hooks": [{ "type": "command", "timeout": 5,
            "command": "node \"<repo>/scripts/kanban-pilot-hook.mjs\" --spool \"<repo>/.kanban-pilot/.hook-spool.jsonl\"" }] }
      ]
   }
}
```

Subscribe to `UserPromptSubmit`, `PostToolUse`, and `Stop` as shown, then set
`kanbanPilot.chat.hookFeed` to `true`. This setup intentionally does not include `PermissionRequest`:
the VS Code editor does not dispatch that event. The receiver appends redacted structural lines to
`.kanban-pilot/.hook-spool.jsonl`; a missing or unreadable spool is reported as **Unavailable** in
task detail, while a readable spool with no task rows is **Enabled · empty**. The receiver cleans
it up when no run is live. Hook rows include an event timestamp and a separate observation timestamp,
so the board can distinguish recent from stale observations without claiming anything about task
completion. Hook entries include only bounded event, session/task attribution, and a tool name where
applicable. Tool arguments, tool output, prompt content beyond task attribution, transcript contents,
transcript paths, credentials, tokens, absolute paths, and sensitive command/query/file-target content
are not exposed.

The receiver is fail-open: every failure path exits successfully and never blocks a Copilot turn.
The short five-second hook timeout also prevents a wedged receiver from holding a turn for the
default thirty seconds. Hook-feed activity stays in the editor unless the existing authenticated
HTTP endpoint is enabled and `chat.transcriptFeedRemote` is separately set to `true`. That remote
setting is explicit sharing consent for the bounded structural hook/transcript projection; when it
is off, the browser receives neither optional rows nor their timestamps. Treat the endpoint's
token-bearing share URL as a secret and follow the security warning in
[Real-time HTTP endpoint](http-endpoint.md).

Clicking **Stop** requests cancellation of the matching task-bound Copilot turn before applying
the card's existing stopped transition. Cancellation is isolated by task and run; if the host
cannot cancel the turn, Kanban Pilot reports the failure instead of claiming that it stopped.

