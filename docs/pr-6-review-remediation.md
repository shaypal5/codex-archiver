# PR 6 Review Remediation

Review stance:

`Review the PR yourself, and take an outsider's view: Pretend you're a senior dev and you really don't like the way this PR is implemented; be brutally honest, and aim to make this PR much better with you feedback.`

Follow-up instruction:

`What is your recommended action/fix per issue raised? Write it down clearly and in detail, then: Apply your recommendations and push to the PR`

## Issues and Fixes

1. The backup manifest preview was too noisy.
   - Issue: The first implementation added every selected item's `plannedPaths` to `backupPreview.targets`, including no-op and blocked items where no future apply would back those files up. That made the machine-readable backup manifest less trustworthy because it mixed required future backup inputs with contextual paths.
   - Recommended action: Keep per-item `plannedPaths` for context, but restrict the top-level backup manifest to paths marked `requiredBeforeApply`.
   - Applied fix: `buildBackupPreview` now includes only required planned paths, and restore tests assert that no-op active rollout files are not included in the top-level backup targets.

2. Invalid process-check API options needed explicit regression coverage.
   - Issue: The API rejected invalid `processCheck` values, but the test suite did not prove that contract. A later refactor could silently accept unsupported process-check modes and weaken future apply-gate semantics.
   - Recommended action: Add an API test that sends an unsupported `processCheck` value and expects a `400` response.
   - Applied fix: The restore API test now covers invalid process-check input.

3. The manifest path schema needed clearer source-vs-target naming.
   - Issue: Archived source rollout files were initially tagged with an archive-target-style kind. That was technically readable but confusing for future apply/undo code that must distinguish source evidence from planned target paths.
   - Recommended action: Use a dedicated archived-source kind and keep target kinds only for future target paths.
   - Applied fix: Added `archived-source-rollout` and use it for archived JSONL source files; `active-session-target` remains reserved for planned future active paths.
