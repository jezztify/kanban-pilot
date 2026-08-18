---
id: TASK-014
title: Update version to 0.1.0
type: feature
state: done
status: idle
created: 2026-08-16T20:50:12Z
updated: 2026-08-17T07:26:35Z
chat: kanban-pilot-TASK-014
copilot_session_id: 44bdb0d3-73ed-4683-b3a3-6c010656651a
scope_hash: 6fa16db
chat_reset_required: false
---

## Request
- Update README
- Update CHANGELOG

## Refined

### Problem statement

The repository documentation still describes the project as a `0.0.1` initial release, while this ticket targets the `0.1.0` release. Update the user-facing release documentation so the README and changelog consistently identify `0.1.0` as the current documented release, without changing implementation or package metadata. The explicit request names only `README.md` and `CHANGELOG.md`; changes to `package.json` or other version-bearing files are outside this ticket.

### Acceptance criteria

- `README.md` identifies `0.1.0` as the current release in its Release Notes section and does not present `0.0.1` as the current release.
- `CHANGELOG.md` contains a `0.1.0` release section describing the initial release, while retaining an `Unreleased` section for future changes without mislabeling the initial release as unreleased.
- The documentation remains valid Markdown, preserves the existing project description and historical release information, and introduces no unrelated content.
- Only `README.md` and `CHANGELOG.md` are identified for implementation; no code, package metadata, or task workflow changes are required.

## Scope

- Update `README.md`:
	- Change the Release Notes version heading from `0.0.1` to `0.1.0`.
	- Keep the existing initial-build release note and review the nearby release-status wording so it does not contradict `0.1.0` being the current documented release.
	- Leave the workflow, feature, settings, requirements, and other documentation unchanged unless needed to remove that version contradiction.
- Update `CHANGELOG.md`:
	- Move the existing initial-release entry out of `## [Unreleased]` into a new `## [0.1.0]` section.
	- Retain `## [Unreleased]` as the place for future changes, without adding an invented release date or unrelated entries.
	- Preserve the existing Keep a Changelog reference and Markdown structure.
- Review the diff to confirm that the documentation consistently presents `0.1.0`, contains no stale current-release reference to `0.0.1`, and does not modify `package.json` or source files.

## Log
- run:rkr7nb8 task:TASK-014 stage:refine result:ok note:"2026-08-16T20:51:01Z — refine completed: defined the README and CHANGELOG-only 0.1.0 documentation update"
- run:rcd3r9y task:TASK-014 stage:develop result:ok note:"2026-08-16T20:54:00Z — develop completed: updated README and CHANGELOG for the 0.1.0 release"
- run:rcd3r9y task:TASK-014 stage:develop result:blocked note:"no receipt found; awaiting late receipt"
