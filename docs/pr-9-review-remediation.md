# PR #9 review remediation

## Review stance

`Review the PR yourself, and take an outsider's view: Pretend you're a senior dev and you really don't like the way this PR is implemented; be brutally honest, and aim to make this PR much better with you feedback.`

## Recommended actions

`What is your recommended action/fix per issue raised? Write it down clearly and in detail, then: Apply your recommendations and push to the PR`

## Issues and fixes

1. The package allowlist was still too broad because `docs/**/*.md` would ship PR review/remediation notes. Those notes are repo process history, not user-facing installed-package documentation. Fix: replace the broad docs glob with exact user-facing docs and make the smoke test reject `docs/pr-*-review-remediation.md` if the package list regresses.

2. The package smoke test proved the bin could print help and version, but it did not prove the installed package could actually serve the browser UI. That left the highest-risk packaged asset path under-tested. Fix: launch `codex-archiver serve` from the installed tarball with a temporary Codex home and index path, then fetch `/` and `/styles.css` from the live packaged server.

3. README carried most release details inline, which made the first-use page heavier and easier to let drift. Fix: keep README install guidance short, add `docs/install-release.md` for the M5 release checklist and artifact contract, and include that doc in the package allowlist.

## Applied remediation

- Narrowed package docs to `docs/install-release.md`, `docs/restore-planning.md`, `docs/search-index.md`, and `docs/visibility-diagnostics.md`.
- Extended `scripts/package-smoke.mjs` to reject PR-process docs in the artifact.
- Extended `scripts/package-smoke.mjs` to start and verify the installed packaged server.
- Added `docs/install-release.md` as the user-facing release checklist.
- Kept this remediation note in the repository but outside the npm package artifact.
