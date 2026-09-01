# Releasing a version

A release runs when a `v<major>.<minor>.<patch>` tag is pushed:

1. Update `version` in `package.json` (and the matching versions in `package-lock.json`), commit.
2. Push a tag that exactly matches, e.g. `v0.3.2`.
3. GitHub Actions installs with `npm ci`, runs tests, build, and lint, packages the VSIX, and
   checks its metadata.
4. Once everything passes, it creates the GitHub Release and attaches
   `kanban-pilot-<version>.vsix`.

