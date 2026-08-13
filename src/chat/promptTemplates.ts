import * as vscode from 'vscode';
import { Stage } from './receipt';

/**
 * Stage prompts (PRD §6.5). Templates live at `.kanban-pilot/prompts/{stage}.md`
 * and are user-editable — the main tuning surface for output quality. The
 * extension seeds defaults on first use; after that, the file on disk wins.
 *
 * Structure is fixed across all three templates:
 *
 *   @{{agentName}}
 *   ## [{{projectName}} {{id}}]
 *   # {{title}}
 *
 *   <stage-specific instruction>
 *
 *   ## Request
 *   <the material this stage needs to do its job>
 *
 *   ## On Completion
 *   <receipt instructions>
 *
 * Four details are load-bearing, not cosmetic: `## [{{projectName}} {{id}}]`
 * makes a misrouted prompt visible to a human (§6.9) — it survived a
 * reformat, not just a banner string; `{{agentName}}` is a real reflection
 * of the board's own Agent badge, not a decoration (`chat/agentNames.ts`);
 * `## Refined`/`## Scope` are inlined under `## Request` rather than
 * referenced, so recency favours a human's edit over the agent's own earlier
 * reasoning — this matters more than usual now that develop and validate
 * reuse the *same* session as refine (§6.8: no reset at Approve); and
 * `task:{{id}}` in the `## On Completion` instruction is the misroute
 * detector.
 *
 * Develop and validate additionally document `propose-task` (§6.12), the
 * optional follow-up-filing line — refine's own template omits it, since
 * refine is scoping the current ticket, not surfacing new ones.
 *
 * `split` (§6.14) is the odd one out structurally: it's the one place
 * `propose-task` is the *primary* completion path rather than an optional
 * extra, and its `result:ok` doesn't mean "this task is scoped" the way
 * refine's does — it means "this task fanned out into others and is now
 * tracking-only." Reads `## Refined`/`## Scope` too (conditionally — they're
 * often empty, since split is usually launched before any refine work has
 * happened) so a split launched as a *retry* of an already-scoped task still
 * has that context.
 */

export interface TemplateVars {
	id: string;
	title: string;
	agentName: string;
	/** The workspace folder's own name — not a configurable display name, just `WorkspaceFolder.name`. */
	projectName: string;
	runId: string;
	request: string;
	refined: string;
	scope: string;
	/** Only meaningful at the develop boundary — did a human edit the scope after refine wrote it? (§6.8) */
	scopeEdited: boolean;
}

const DEFAULT_REFINE_TEMPLATE = `@{{agentName}}
## [{{projectName}} {{id}}]
# {{title}}

Refine this ticket to understand more from the user. Read the request below
and make sure you understand what's actually being asked before writing
anything. Then:

1. Write a sharpened problem statement and acceptance criteria under
   \`## Refined\`.
2. Write a concrete implementation checklist under \`## Scope\` — the specific
   files or changes involved, as a list a developer could work through.

Do not write or edit any code. This stage is scoping only.

## Request
{{request}}

## On Completion
Append this line to the \`## Log\` section of \`.kanban-pilot/tasks/{{id}}.md\`:
- run:{{runId}} task:{{id}} stage:refine result:ok note:"<one line summary>"
If you could not proceed, use result:blocked with the reason in the note.
Do not edit anything else in this file — not the \`---\`-delimited frontmatter
block at the top (its \`state\`/\`status\` fields included), and not \`## Request\`.
The extension owns that block and moves the card on its own once it sees your
\`## Log\` line; editing it yourself will conflict with that and confuse the board.
`;

const DEFAULT_DEVELOP_TEMPLATE = `@{{agentName}}
## [{{projectName}} {{id}}]
# {{title}}

Implement this task.
{{#scopeEdited}}
The scope below was revised by a human after refinement. Treat it as the
final word — anything you reasoned about earlier in this conversation is
superseded.
{{/scopeEdited}}
Implement exactly the checklist under Scope below and nothing else. If
something outside it blocks you, stop and report it rather than improvising.

## Request
**Refined**
{{refined}}

**Scope**
{{scope}}

## On Completion
Append this line to the \`## Log\` section of \`.kanban-pilot/tasks/{{id}}.md\`:
- run:{{runId}} task:{{id}} stage:develop result:ok note:"<one line summary>"
If you could not proceed, use result:blocked with the reason in the note.
Do not edit anything else in this file — not the \`---\`-delimited frontmatter
block at the top (its \`state\`/\`status\` fields included), and not \`## Request\`,
\`## Refined\`, or \`## Scope\`. The extension owns the frontmatter and moves the
card on its own once it sees your \`## Log\` line; editing it yourself will
conflict with that and confuse the board.

If you noticed clearly out-of-scope follow-up work along the way — not
something to do now, but worth not losing — file it as its own task instead of
expanding this one. Add up to a few lines like this to the same \`## Log\`:
- propose-task run:{{runId}} title:"<short title>" note:"<why this is separate, one line>"
Only do this for concrete, actionable follow-ups you actually noticed while
working, not speculative ideas or things already covered by Scope.
`;

const DEFAULT_VALIDATE_TEMPLATE = `@{{agentName}}
## [{{projectName}} {{id}}]
# {{title}}

Validate this task's acceptance criteria. Review the implementation below
against them — read the actual code, and run tests if any exist for the area
you're checking. Do not fix anything yourself; only report whether it passes.

## Request
**Refined**
{{refined}}

**Scope**
{{scope}}

## On Completion
Append exactly one of these lines to the \`## Log\` section of
\`.kanban-pilot/tasks/{{id}}.md\`:
- run:{{runId}} task:{{id}} stage:validate result:ok note:"<what you checked>"
  — the criteria are met.
- run:{{runId}} task:{{id}} stage:validate result:failed note:"<what's missing>"
  — the criteria are not met; the ticket goes back to In Progress for another pass.
If you could not determine a pass or fail, use result:blocked with the reason
in the note.
Do not edit anything else in this file — not the \`---\`-delimited frontmatter
block at the top (its \`state\`/\`status\` fields included), and not \`## Request\`,
\`## Refined\`, or \`## Scope\`. The extension owns the frontmatter and moves the
card on its own once it sees your \`## Log\` line; editing it yourself will
conflict with that and confuse the board.

If checking turned up clearly out-of-scope follow-up work — not a reason to
fail this check, but worth not losing — file it as its own task instead of
folding it in here. Add up to a few lines like this to the same \`## Log\`:
- propose-task run:{{runId}} title:"<short title>" note:"<why this is separate, one line>"
Only do this for concrete, actionable follow-ups you actually noticed while
checking, not speculative ideas.
`;

const DEFAULT_SPLIT_TEMPLATE = `@{{agentName}}
## [{{projectName}} {{id}}]
# {{title}}

This ticket may be too big for one pass. Decide whether it should be split
into smaller, independently workable tasks — and if so, do it now, before any
scoping or implementation work happens on it directly.

Read the request below (and any existing Refined/Scope, if this task already
went through refine once). If it genuinely breaks into smaller independent
pieces, file each one as its own task (see On Completion) and leave this
ticket as a tracking-only parent: write a short "Split into: <working
titles>" note under \`## Scope\` — you won't know the real task ids yet, the
board will assign those. If it does **not** need splitting — already small
enough for one pass — say so and stop. Do not write a Scope checklist here;
that's the normal Refine stage's job, not this one.

## Request
{{request}}
{{#refined}}

**Existing Refined**
{{refined}}
{{/refined}}
{{#scope}}

**Existing Scope**
{{scope}}
{{/scope}}

## On Completion
If you split this ticket, file each smaller task first — one line per task,
added to the \`## Log\` section of \`.kanban-pilot/tasks/{{id}}.md\`:
- propose-task run:{{runId}} title:"<short title>" note:"<what this piece covers>"
Then append this line after them:
- run:{{runId}} task:{{id}} stage:split result:ok note:"split into N tasks: <short list>"
This task becomes tracking-only once split — do not also give it an
implementation Scope, and do not implement anything yourself here.

If it does not need splitting, append this instead, and nothing else:
- run:{{runId}} task:{{id}} stage:split result:blocked note:"<why one ticket is fine>"
This leaves it exactly where a normal Refine can pick it up next.

Do not edit anything else in this file — not the \`---\`-delimited frontmatter
block at the top (its \`state\`/\`status\` fields included), and not \`## Request\`.
The extension owns that block and moves the card on its own once it sees your
\`## Log\` line; editing it yourself will conflict with that and confuse the board.
`;

const DEFAULT_TEMPLATES: Record<Stage, string> = {
	refine: DEFAULT_REFINE_TEMPLATE,
	develop: DEFAULT_DEVELOP_TEMPLATE,
	validate: DEFAULT_VALIDATE_TEMPLATE,
	split: DEFAULT_SPLIT_TEMPLATE,
};

function promptsDir(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
	return vscode.Uri.joinPath(workspaceFolder.uri, '.kanban-pilot', 'prompts');
}

function promptFile(workspaceFolder: vscode.WorkspaceFolder, stage: Stage): vscode.Uri {
	return vscode.Uri.joinPath(promptsDir(workspaceFolder), `${stage}.md`);
}

/** Writes the default template to disk only if the user hasn't created one. */
async function ensureTemplate(workspaceFolder: vscode.WorkspaceFolder, stage: Stage): Promise<void> {
	const uri = promptFile(workspaceFolder, stage);
	try {
		await vscode.workspace.fs.stat(uri);
		return; // already exists — never overwrite a user's edits
	} catch {
		/* doesn't exist yet */
	}

	await vscode.workspace.fs.createDirectory(promptsDir(workspaceFolder));
	await vscode.workspace.fs.writeFile(uri, Buffer.from(DEFAULT_TEMPLATES[stage], 'utf8'));
}

/** Reads a stage's template, seeding the default first if none exists yet. */
export async function loadPromptTemplate(
	workspaceFolder: vscode.WorkspaceFolder,
	stage: Stage,
): Promise<string> {
	await ensureTemplate(workspaceFolder, stage);
	const bytes = await vscode.workspace.fs.readFile(promptFile(workspaceFolder, stage));
	return Buffer.from(bytes).toString('utf8');
}

/**
 * Minimal mustache-lite: `{{var}}` substitution and `{{#flag}}...{{/flag}}`
 * blocks gated on a boolean. Deliberately not a real templating engine — the
 * template set is small, fixed, and entirely our own (§6.5), so anything more
 * would be dependency weight without a matching need.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
	let out = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, key: string, inner: string) =>
		vars[key as keyof TemplateVars] ? inner : '',
	);
	out = out.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
		const value = vars[key as keyof TemplateVars];
		return value === undefined ? '' : String(value);
	});
	return out;
}
