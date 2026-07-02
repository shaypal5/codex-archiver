# PR 8 Review Remediation

Planning notation: `M4-RESTORE-UNDO-BACKUPS`

Parent milestone: `M4: Backup-backed restoration`

## Review stance

Prompt used:

```text
Review the PR yourself, and take an outsider's view: Pretend you're a senior dev and you really don't like the way this PR is implemented; be brutally honest, and aim to make this PR much better with you feedback.
```

Second-step prompt used:

```text
What is your recommended action/fix per issue raised? Write it down clearly and in detail, then: Apply your recommendations and push to the PR
```

## Issues and Actions

1. The first implementation trusted the report path too loosely. It validated the manifest backup root, but it did not also require the source apply report's recorded backup roots to match the selected rollback root. A copied or edited report could point rollback at an artifact set the user did not intend.

   Recommended action: validate `sourceReport.result.backupRoot` and `sourceReport.backupManifest.backupRoot` against the explicit rollback root before preview can become apply.

   Applied change: `undo-report-schema` now rejects source apply reports whose embedded backup root does not match the requested backup root.

2. Backup paths were checked lexically against the backup root, but an attacker or corrupted artifact could replace a backup file with a symlink inside the root that resolves elsewhere.

   Recommended action: reject symlinked backup files and require existing backup files to realpath inside the backup root.

   Applied change: `undo-manifest-paths` now uses realpath validation for restore-file backup paths and rejects symlinked backup files.

3. The temp-file restore helper did not remove the temporary sibling if copy or rename failed. The operation was still conservative, but a failed rollback could leave confusing temp artifacts next to Codex files.

   Recommended action: wrap backup copy and rename in cleanup logic that removes the temp file on failure.

   Applied change: `restoreFromBackupTarget` now removes the temporary sibling before rethrowing failures.

4. A confirmed undo failure before `safetyBackup` was assigned could return a JSON result to the caller without persisting a machine-readable undo report.

   Recommended action: once the user has supplied the confirmation token or phrase, persist non-preview undo reports even if failure happens before the safety backup manifest is fully available.

   Applied change: confirmed non-preview undo results now write `restore-undo-report.json` under the rollback-safety root.

5. Negative tests covered traversal and bad hashes, but not report/root mismatch or symlinked backup artifacts.

   Recommended action: add explicit regression coverage for mismatched report backup roots and symlinked backup files.

   Applied change: restore undo tests now cover report-root mismatch, manifest target traversal, backup symlink rejection, bad hash rejection, and no mutation after those blockers.
