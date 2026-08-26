# Legacy VS Code Remote Tunnel smoke validation

> This checklist applies only to the legacy VS Code extension transport. It is not a hosted-service
> smoke test. For the separate browser/API runtime, use [hosted-smoke.md](hosted-smoke.md).

**Recorded:** 2026-08-25  
**Status:** Unavailable — no authenticated second client or active host tunnel was available in this environment

## Evidence

The non-invasive host check was run from the repository workspace:

- Command: `code tunnel status`
- Result: `{"tunnel":null,"service_installed":false}`
- No tunnel was started, and no credentials or authentication tokens were requested or stored.

This is an evidence-unavailable record, not a passing remote smoke test. The local extension suite,
production bundle, VSIX package, and skill installer tests do not prove Remote Tunnel transport or
Copilot Chat behavior from a second client.

## Required smoke pass when a client is available

1. On the host, open this workspace in VS Code, sign in to GitHub Copilot, and start Remote Tunnel
   Access with **Remote Tunnels: Turn on Remote Tunnel Access** or `code tunnel`.
2. From an authenticated VS Code desktop or `vscode.dev` client, connect to the host tunnel and
   open the same workspace.
3. Run **Kanban Pilot: Open Board** and verify the active task set, cards, selected-task detail,
   Settings, and connection indicator load from the host.
4. Change a host task or setting and verify the remote board refreshes without a manual reload;
   reconnect once and verify a full current snapshot is restored.
5. Open a task's **Open Chat** action and verify the real task-scoped Copilot Chat editor opens.
   Exercise one representative gated action and, where supported, a blocked-chat question or tool
   approval. Confirm that the expected receipt, task/run/stage identity, and board state agree.
6. Confirm a disconnect or client reload does not fabricate success, duplicate a run, cross task
   sets, or allow an older snapshot to overwrite a newer one.
7. Record the client and VS Code versions, the checks performed, and any capability diagnostic or
   limitation before treating the remote smoke criterion as passed.
