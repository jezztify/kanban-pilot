# Real-time HTTP endpoint

Kanban Pilot can expose the **existing extension host** through an authenticated HTTP endpoint.
It does not create another board, task store, state machine, or run manager: task Markdown and
the current `TaskStore` remain authoritative, while mutations use the existing `RunManager`.

Opening an endpoint in a browser serves **the extension's own board webview** — the same
document, markup, styling, and message protocol `BoardPanel` renders in the editor — rather than a
second, reduced board. A browser client therefore gets drag-and-drop reordering, the task detail
and edit panes, attachments, Mermaid rendering, Settings, gates, agent assignment, and task sets,
and any change to the board reaches both clients at once. Each connected browser holds its own
board session, so one person's card selection does not move anybody else's. The Task set picker
lists the workspace's registered sets, but selecting one is browser-session-local: it rebinds only
that browser session's board, attachments, activity, and actions. It does not change the active
VS Code board, another browser session, or the endpoint's default set for new sessions. The
endpoint's bearer credential still gates every request, and a session can read attachments and
task data only from its currently selected registered task set.

The browser board uses the same **Workspace Activity** button, modal, and
`workspaceActivity/state` message protocol as the VS Code board. The state is read from the active
task-set activity file, is delivered on the initial board push and on later activity changes, and
is replayed when a browser reconnects. There is no separate activity API or browser-side history.
Switching task sets rebinds the board to that set's activity file, so records from another set are
never included. The history remains read-only from the modal; its controls do not mutate task
Markdown.

The endpoint starts automatically for every task set in every open workspace. Each board receives an
OS-selected free port and an in-memory bearer token; there is no HTTP enablement, port, host, or
token setting. Endpoints bind to all interfaces so trusted LAN clients can connect, and the board
URL uses the actual port plus a reachable LAN address. A board endpoint remains bound to its task
set, so switching the active VS Code board never changes an already shared browser board.

One Kanban Pilot Registry is started per VS Code user profile. All extension hosts in that profile
attach to the same Registry process through a shared startup lock and client lease. The Registry
also uses an OS-selected port and binds to the same reachable interfaces as the boards. When a
workspace is ready, it registers its credential-free board URL and a private in-memory redirect
target. The public listing never contains a board token. The process exits after all VS Code hosts
release their leases and its metadata is discarded.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | `GET` | The board webview itself. Each load starts a board session. |
| `/session/events` | `GET` | That session's board message stream. |
| `/session/messages` | `POST` | One board message from that session. |
| `/resource/:root/*` | `GET` | Bundled assets and task attachments the board references. |
| `/health` | `GET` | Endpoint liveness, current revision, and live session count. |
| `/api/board` | `GET` | Current authoritative board snapshot and active task set. |
| `/api/events` | `GET` | Server-sent events. Sends a full snapshot immediately and on every task, attachment, configuration, task-set, or run update. |
| `/api/tasks/:taskId/actions` | `POST` | Runs an existing validated card action. Body: `{ "action": "develop" }`. |
| `/api/tasks/:taskId/pending` | `POST` | Applies the existing pending completion gate. |

The direct board connection URL authenticates with its process-local `token` query parameter. API
clients can instead send `Authorization: Bearer <process-local board token>` on every request,
including the event stream. Consumers must treat `revision` as monotonic, only apply newer
snapshots, and reconnect to obtain the immediate full snapshot.

This is a real-time transport for the existing board and actions, not a replacement UI. The
current `BoardPanel` remains canonical — it is what a browser runs. Existing Copilot Chat sessions
remain VS Code editor sessions; task actions over HTTP still use the existing `RunManager`. When
the existing `chat.transcriptFeedRemote` opt-in is enabled, the browser may receive the same
bounded activity projection as the editor: durable progress, labeled structural hook rows, and
delayed structural transcript rows with event/observation timestamps. It never receives private
Copilot transcript content, prompts, reasoning, tool payloads, credentials, tokens, absolute paths,
or sensitive command/query/file-target content, and reconnects do not fabricate new observations.
With that opt-in disabled, hook/transcript activity is withheld from the browser entirely.

Two board actions act on the editor rather than the board — **Open task file** and **Open Chat** —
so they are hidden on browser clients instead of silently operating on the host's screen.
Dialogs that were VS Code modals (new/rename/delete task set, delete task, recover a stale
completion) are now rendered by the board itself, so they appear for whoever clicked them.

When the endpoint starts, click **Kanban Pilot: Share** in VS Code's status bar to display a
scannable QR code and a copyable Registry URL. The Registry page lists currently live workspaces;
selecting one redirects to that board's token-bearing connection URL. Treat the Registry URL as a
private LAN share link because anyone who can reach it can discover and open the registered boards.
Direct HTTP provides no TLS, so use a trusted LAN or place the service behind an appropriate TLS
boundary. If a wildcard bind has no usable LAN IPv4, the generated URL falls back to `localhost`.

