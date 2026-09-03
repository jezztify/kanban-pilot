# Kanban Pilot workspace registry

This standalone Node service is a durable directory of currently reachable Kanban Pilot boards.
It stores only sanitized board URLs, workspace ids, display names, and heartbeat timestamps. It
does not proxy board traffic, receive task data, or store the board access token.

Set `KANBAN_PILOT_REGISTRY_CREDENTIAL` to a registration secret and optionally set
`KANBAN_PILOT_REGISTRY_DATA` to the durable JSON-file location. Run `npm start` from this folder.
It listens on port `9090` by default; set `PORT` to use another port.
The public landing page is `/`; workspaces use authenticated `PUT /api/workspaces` heartbeats and
authenticated `DELETE /api/workspaces/:id` removal. `GET /api/workspaces` and `GET /health` are
safe public endpoints. Records expire after 90 seconds without a heartbeat.

The `/` landing page is a responsive, keyboard-friendly workspace launcher. It puts the live
workspace count and an explicit `Refresh` action near the top, renders available workspaces as
compact cards, and provides quiet skeleton loading, empty, and temporary-error states. A failed
refresh retains the last successful list when one is available. Selecting a workspace follows the
sanitized `boardUrl` returned by `GET /api/workspaces`; the page does not poll, proxy board traffic,
or create a second board model. The public page displays only workspace names, textual live status,
and safe connection links. Registration credentials, board access tokens, task data, and board
snapshots remain outside the Registry UI.