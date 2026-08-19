---
id: TASK-008
title: VSCode Extensions Logo should show activity-icon.svg
type: feature
state: done
status: idle
created: 2026-08-15T08:26:33Z
updated: 2026-08-15T08:41:04Z
chat: kanban-pilot-TASK-008
copilot_session_id: fbcd595c-8faf-476f-bbd3-462de2e05041
scope_hash: 0b08d82
chat_reset_required: false
---

## Request
When I open VSCode's extension sidebar, I want to see Kanban Pilot's icon to be activity-icon.svg

## Refined

### Problem statement
The extension manifest currently assigns `media/activity-icon.svg` to Kanban Pilot's Activity Bar container and Board view, but it does not define an extension-level logo for VS Code's Extensions view. Add the same Kanban Pilot artwork as the extension logo. Because the VS Code extension packager rejects SVG files for the top-level extension `icon`, the Extensions view must use a PNG rendering of the exact SVG artwork while the existing Activity Bar and Board contributions continue using `activity-icon.svg`.

### Acceptance criteria
- The installed or packaged Kanban Pilot entry in VS Code's Extensions view displays the Kanban Pilot artwork matching `media/activity-icon.svg` rather than the default/missing icon.
- The extension manifest's top-level `icon` property points to the valid PNG rendering of `activity-icon.svg`, and the referenced file is included in the packaged extension.
- The Activity Bar container and Board view continue to reference `media/activity-icon.svg` with no regression.
- Packaging succeeds and a manual install/reload confirms that the logo renders in the Extensions view without a broken-image or fallback icon.

## Scope
- Update `package.json` to add the top-level extension `icon` property, pointing to the new PNG derivative used by VS Code's Extensions view; do not replace the existing `contributes.viewsContainers.activitybar` or `contributes.views` SVG references.
- Create `media/activity-icon.png` from `media/activity-icon.svg`, preserving the SVG's artwork, transparent background, and a suitable extension-icon size (for example, 128×128).
- Confirm `.vscodeignore` does not exclude the new media asset and that the generated VSIX contains both icon assets.
- Run the existing packaging command (`npm run vsix` or the equivalent `vsce package` command), install/reload the VSIX, and verify the logo in the Extensions view and Activity Bar.
- No TypeScript, board behavior, or automated-test changes are expected unless packaging or the manual verification exposes an icon-specific issue.

## Log
- run:rdphi3t task:TASK-008 stage:refine result:ok note:"2026-08-15T08:28:35Z — refinement clarified the Extensions-view logo, SVG packaging constraint, and manifest/media verification scope"
- run:r3hz24u task:TASK-008 stage:develop result:ok note:"2026-08-15T08:37:31Z — added the PNG extension logo, packaged the VSIX with both icon assets, and installed it successfully"
- run:r3hz24u task:TASK-008 stage:develop result:blocked note:"no receipt found; awaiting late receipt"
