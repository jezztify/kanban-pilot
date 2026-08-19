---
id: TASK-015
title: Add Github Actions to release a versioned extension package
type: feature
state: done
status: idle
created: 2026-08-16T21:06:06Z
updated: 2026-08-17T07:26:37Z
chat: kanban-pilot-TASK-015
copilot_session_id: 60f5a3f4-e0c4-41e4-b808-9cb885747b23
scope_hash: b22a931
chat_reset_required: false
---

## Request
Add Github Actions to release a versioned extension package

## Refined

### Problem statement

The repository already has a version in `package.json`, reproducible dependency installation via
`npm ci`, a production bundle, and an existing `vsce` packaging command, but it has no GitHub
Actions workflow that turns an intentional version release into a validated, downloadable VSIX.
Add a tag-driven release workflow that uses the manifest version as the package version, verifies
that the release tag matches it, runs the repository's quality gates, packages the extension, and
publishes that exact VSIX as a GitHub Release. Version changes remain an explicit maintainer
operation; this ticket does not infer automatic version bumping or Visual Studio Marketplace
publishing.

### Acceptance criteria

- A workflow under `.github/workflows/` runs for an intentional semver tag such as `v0.1.0` and
  does not publish a release when the tag does not exactly match the `version` in `package.json`.
- The workflow installs dependencies from the lockfile with `npm ci`, runs the existing build,
  lint, and extension-test checks in a headless CI-compatible environment, and stops before the
  release step if any check fails.
- The workflow invokes the repository's supported VSIX packaging path and produces a VSIX whose
  manifest and filename identify the version from `package.json`.
- A GitHub Release is created for the triggering tag and has the generated VSIX attached as a
  downloadable asset; the asset is the package produced by that same successful workflow run.
- The workflow declares only the permissions it needs and uses the repository-provided
  `GITHUB_TOKEN`; no Visual Studio Marketplace token or additional secret is required for this
  GitHub Release flow.
- The release process is documented for maintainers: update the manifest/lockfile version as
  appropriate, commit the change, and push the matching `v<version>` tag. Marketplace publishing,
  automatic version selection or bumping, and unrelated CI changes remain out of scope.

## Scope

- Add `.github/workflows/release.yml`:
	- Trigger on pushed tags matching the repository's `v<major>.<minor>.<patch>` release convention.
	- Check out the tagged commit, set up the supported Node.js runtime, enable npm dependency caching
	  where appropriate, and run `npm ci` from the lockfile.
	- Read `package.json` in the job and fail early when the tag's version is not exactly the manifest
	  version, so a release cannot contain a package with a different version.
	- Run the existing `npm test` quality gate in a Linux headless-compatible way; retain its current
	  compile, bundle, lint, and extension-test coverage rather than duplicating those commands in
	  the workflow.
	- Run the existing `npm run vsix` packaging command after the checks and identify the single
	  generated `.vsix` file as the release asset.
	- Grant the job the minimum `contents: write` permission and use the built-in `GITHUB_TOKEN` to
	  create a GitHub Release for the tag and upload the generated VSIX, with generated release notes.
	- Ensure packaging or verification failures prevent the release-publishing step from running.
- Review `package.json` and `package-lock.json` as the release version sources:
	- Preserve the existing `vsix` script and `@vscode/vsce` dependency unless implementation testing
	  proves a narrowly-scoped packaging adjustment is required.
	- Document in the workflow or README that maintainers must keep the manifest and lockfile versions
	 consistent before pushing the matching tag; do not add automatic version mutation.
- Update `README.md` with a concise release-maintainer section covering the version update, matching
	 `v<version>` tag, workflow checks, and the resulting GitHub Release VSIX asset. Do not document
	 Marketplace publishing because it is not part of this ticket.
- Validate the workflow from a clean checkout or equivalent CI run: dependency installation,
	 tag/version mismatch rejection, successful test/build/package execution, VSIX version metadata,
	 and GitHub Release asset publication. Review the diff to confirm no source code, task files other
	 than this scope record, or unrelated CI workflows were changed.

## Log
- run:r52cogv task:TASK-015 stage:refine result:ok note:"2026-08-16T21:07:12Z — refine completed: defined tag-driven version validation, CI packaging, GitHub Release publication, and maintainer documentation scope"
- run:rxzgfha task:TASK-015 stage:develop result:ok note:"2026-08-16T21:12:38Z — develop completed: added tag-validated GitHub Release workflow, VSIX metadata checks, and maintainer release instructions"
- run:rxzgfha task:TASK-015 stage:develop result:blocked note:"no receipt found; awaiting late receipt"
