# Restore Planning

Planning notation: `M3-RESTORE-PLAN`

Current extension: `M3-PREFLIGHT-BACKUP-PREVIEW`

Apply extension: `M4-RESTORE-APPLY-BACKUPS`

Undo extension: `M4-RESTORE-UNDO-BACKUPS`

Parent milestones: `M3: Restore planning and safety checks`; `M4: Backup-backed restoration`

`codex-archiver restore plan` creates an explicit dry-run plan for selected thread ids. It is read-only with respect to `~/.codex`: it does not create backups, edit SQLite, rewrite `session_index.jsonl`, move rollout files, or apply restore changes.

`codex-archiver restore apply` is the first intentionally mutating restore path. It is limited to archived SQLite threads with existing archived JSONL evidence. It recomputes the plan immediately before applying, requires the confirmation token or phrase from the plan, blocks on any non-passing preflight check, creates timestamped backups, mutates with SQLite transaction semantics where possible, writes a machine-readable report, rebuilds the derived search index, and verifies by rescanning.

`codex-archiver restore undo` rolls back from an explicit PR #7 restore apply backup/report artifact. It previews by default, validates the apply report and backup manifest before mutation, requires the generated undo confirmation token or phrase to apply, creates a new rollback safety backup of current targets, restores backed files with temporary-file rename, removes apply-created active-session files recorded in the apply report, rebuilds the derived search index, and writes a machine-readable undo report.

## CLI

```bash
node dist/cli.js restore plan THREAD_ID...
node dist/cli.js restore plan --ids thread-a,thread-b --json
node dist/cli.js restore plan THREAD_ID --process-check strict
node dist/cli.js restore plan THREAD_ID --skip-process-check
node dist/cli.js restore apply THREAD_ID --confirm-token restore-...
node dist/cli.js restore apply THREAD_ID --confirm-phrase "apply restore restore-..."
node dist/cli.js restore undo --report /path/to/restore-report.json
node dist/cli.js restore undo --backup-root /path/to/backup-root
node dist/cli.js restore undo --report /path/to/restore-report.json --confirm-token undo-...
node dist/cli.js restore undo --report /path/to/restore-report.json --confirm-phrase "undo restore undo-..."
```

Useful flags:

- `--codex-home /path/to/.codex`: inspect a non-default Codex home.
- `--index-path /path/to/index.sqlite`: include the derived search-index path in future backup/reindex previews.
- `--ids id-a,id-b`: pass selected ids as a comma-separated list.
- `--process-check warn|strict|skip`: control best-effort Codex process detection. `warn` is the default and reports running Codex processes as warnings. `strict` reports them as failed preflight checks for future apply readiness. `skip` records the process check as unknown for tests and CI.
- `--skip-process-check`: shorthand for `--process-check skip`.
- `--json`: accepted for explicit machine-readable CLI usage. Output is always JSON.
- `--confirm-token restore-...`: required for apply unless `--confirm-phrase` is used. The token is shown in `reportPreview.confirmationToken`.
- `--confirm-phrase "apply restore restore-..."`: equivalent apply confirmation phrase shown in `reportPreview.confirmationPhrase`.
- `--report /path/to/restore-report.json`: explicit restore apply report for undo preview/apply.
- `--backup-root /path/to/backup-root`: explicit backup root for undo; the report is resolved as `<backup-root>/restore-report.json`.
- `--confirm-token undo-...`: required for undo apply unless `--confirm-phrase` is used. Without confirmation, undo returns a dry-run preview and mutates nothing.
- `--confirm-phrase "undo restore undo-..."`: equivalent undo confirmation phrase shown in the undo preview.

Both plan and apply require at least one selected thread id. There are no broad or implicit restore batches.

## API

The local web app exposes:

```text
POST /api/restore/plan
POST /api/restore/apply
POST /api/restore/undo
```

Request body:

```json
{
  "selectedThreadIds": ["thread-a", "thread-b"],
  "processCheck": "warn",
  "confirmationToken": "restore-..."
}
```

`processCheck` may be `warn`, `strict`, or `skip`. `skipProcessCheck: true` is also accepted for test and CI callers.
`confirmationToken` or `confirmationPhrase` is required by `/api/restore/apply`; `/api/restore/plan` ignores those fields.
`/api/restore/undo` accepts `reportPath` or `backupRoot` plus the same process-check and confirmation fields. Without confirmation it returns a dry-run undo preview. With confirmation it applies rollback only after validation and preflight pass.

Because this is a non-GET local API route, requests must include:

```text
X-Codex-Archiver-Intent: local-api
```

When an `Origin` header is present, it must be a localhost origin. Both restore POST endpoints follow the same explicit local-intent guard.

## Plan Classifications

Each selected id becomes one plan item:

- `archived-sqlite-thread`: SQLite marks the thread archived and an archived rollout file exists. M4 apply can copy the archived JSONL into the active sessions tree, update `session_index.jsonl`, and unarchive/update the SQLite row after backup.
- `jsonl-only-archived-thread`: archived JSONL exists without a SQLite row. M4 apply skips this case because inserting a valid SQLite row still needs a tighter schema contract.
- `ui-hidden-active-thread`: active JSONL exists without archive semantics. The recommendation is visibility diagnostics or active visibility recovery, not archive restore.
- `missing-rollout-source`: SQLite references a missing rollout/session file. Restore is blocked until source JSONL evidence exists.
- `already-active`: active local Codex state already exists. No restore action is needed.
- `not-found`: the selected id was not found in scanned local evidence.
- `unsupported`: scanned evidence exists but does not match a safe restore-planning case yet.

## Safety Contract

The plan includes:

- `readOnly: true` and `mutationAllowed: false`.
- `impactPreview` counts for future apply, diagnostic-only, blocked, no-op, and rejected selections.
- `backupPreview` describing future timestamped backup targets. Planning never creates those backups.
- `preflight` checks with `passed`, `warning`, `failed`, or `unknown` status for selected ID presence, rollout source existence, target path conflicts, and Codex process closure.
- `backupPreview.targets` as a machine-readable manifest preview. Entries include source path, planned backup path, kind, existence, size, mtime, and small-file SHA-256 when inexpensive.
- `reportPreview` describing the machine-readable restore apply report schema, planned report path, plan hash, confirmation token, confirmation phrase, and undo/audit fields. Planning never writes the report.
- Per-thread `futureActions`, `backupPreview`, and `mutationPreview` arrays.
- Per-thread `plannedPaths` and `validations` for source evidence and active/archive target conflict checks.

Apply must create timestamped backups before mutation, use a transaction-backed SQLite update plan, keep cache/index state under `~/.cache/codex-archiver`, and emit a machine-readable restore report.

## Preflight Checks

Preflight is non-mutating. Planning returns a full report even when checks fail. Apply recomputes preflight immediately before mutation and blocks unless every check passes.

- `selected-ids-present`: fails when a selected id is no longer present in the current scan.
- `rollout-sources-exist`: fails when SQLite or scan evidence references a missing rollout/session JSONL file.
- `target-path-conflicts`: fails when a planned active/archive target path already exists outside the selected thread evidence.
- `codex-processes-closed`: uses best-effort process detection for Codex Desktop, app-server, and codex processes. It ignores Electron crashpad helper processes because they can remain briefly after the app exits and do not represent an active Codex UI/server. It is `warning` in default mode when meaningful matches are found, `failed` in `strict` mode, and `unknown` when skipped or unavailable.

Process detection is best-effort and cross-platform-ish: macOS/Linux use `ps`, Windows uses `tasklist`. Apply requires the user to close Codex and blocks on warnings, failures, or unknown process-check status.

## Backup and Report Preview

The planned backup root is deterministic for the selected IDs and plan timestamp:

```text
~/.cache/codex-archiver/backups/restore-<timestamp>-<selectionhash>
```

The manifest previews files a future apply would need to back up, including `state_5.sqlite`, `session_index.jsonl` when present, affected rollout/session files, relevant target paths when they already exist, and the derived search index path. Missing files remain visible in the preview with `exists: false`; planning does not create directories or files.

## Apply Report

M4 apply writes:

```text
<backup-root>/backup-manifest.json
<backup-root>/restore-report.json
```

The report includes:

- selected thread ids, `planHash`, and `confirmationToken`
- preflight checks from the freshly recomputed plan
- backup manifest targets with source paths, backup paths, sizes, mtimes, and hashes when available
- per-item planned and applied mutations
- top-level mutation events for active JSONL copy, `session_index.jsonl` update, SQLite unarchive transaction, and derived index rebuild
- verification status from a post-apply rescan
- next user steps and explicit limitations

If confirmation is invalid or preflight blocks, apply writes a blocked report but does not mutate `~/.codex` or create file backups. If a failure happens after file changes but before the SQLite transaction completes, apply attempts best-effort rollback of copied active-session files and `session_index.jsonl` before writing the failure report.

## Undo Report

M4 undo writes a report only when confirmed rollback starts:

```text
<backup-root>/rollback-safety/restore-undo-<timestamp>/rollback-safety-manifest.json
<backup-root>/rollback-safety/restore-undo-<timestamp>/restore-undo-report.json
```

The undo preview/report includes:

- recognized source apply report metadata and selected thread ids
- validation for report schema, manifest schema, backup paths, target restore paths, backup sizes, and backup hashes
- preflight process checks
- target actions: `restore-file`, `remove-created-file`, or `skip-missing-original`
- generated undo confirmation token and phrase
- rollback safety backup manifest for current target files
- restored/removed file results
- verification from restored-file hash checks and a Codex storage rescan
- next user steps and limitations

Undo rejects mutation when report or manifest validation fails, when backup files are missing or hash/size metadata does not match, when target paths leave the intended Codex home or configured search index, when symlink escapes are detected, or when Codex process preflight does not pass. Dry-run preview is still available for a valid artifact even when process preflight would block confirmed mutation.
