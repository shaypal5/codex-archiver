# PR 7 Review Remediation

Review stance used:

`Review the PR yourself, and take an outsider's view: Pretend you're a senior dev and you really don't like the way this PR is implemented; be brutally honest, and aim to make this PR much better with you feedback.`

Follow-up instruction used:

`What is your recommended action/fix per issue raised? Write it down clearly and in detail, then: Apply your recommendations and push to the PR`

## Issues, Recommendations, and Applied Fixes

1. Backup copies were byte-correct but not timestamp-preserving.
   - Issue: The first implementation used plain file copies for backups and active rollout copies. That was acceptable for content rollback, but weak for auditability because the backup manifest records source mtimes.
   - Recommended action: Use Node's timestamp-preserving copy support for backup copies and active rollout copies, then add a test assertion so this does not regress.
   - Applied fix: Switched backup and rollout copying to `cp(..., { preserveTimestamps: true })` and added restore-apply test coverage that compares source, backup, and active-copy mtimes.

2. Missing backup targets lost their planned backup path in the apply manifest.
   - Issue: The first apply manifest replaced `backupPath` with an empty string for missing planned targets. That made the report less machine-readable and less useful for audit tooling.
   - Recommended action: Preserve the planned `backupPath` for every manifest target, while relying on `exists: false` to show that no file was copied.
   - Applied fix: Kept the planned backup path in manifest entries for missing targets.

3. Verification failure messaging could be misleading.
   - Issue: If mutations completed but verification failed, the report status would become `failed` or `partial`, but the message could still say the restore completed.
   - Recommended action: Make result messaging explicitly distinguish successful mutation from successful verification.
   - Applied fix: Report messages now say when mutations completed but verification ended with a non-success status.
