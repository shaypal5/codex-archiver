# Restore Planning

Planning notation: `M3-RESTORE-PLAN`

Current extension: `M3-PREFLIGHT-BACKUP-PREVIEW`

Parent milestone: `M3: Restore planning and safety checks`

`codex-archiver restore plan` creates an explicit dry-run plan for selected thread ids. It is read-only with respect to `~/.codex`: it does not create backups, edit SQLite, rewrite `session_index.jsonl`, move rollout files, or apply restore changes.

## CLI

```bash
node dist/cli.js restore plan THREAD_ID...
node dist/cli.js restore plan --ids thread-a,thread-b --json
node dist/cli.js restore plan THREAD_ID --process-check strict
node dist/cli.js restore plan THREAD_ID --skip-process-check
```

Useful flags:

- `--codex-home /path/to/.codex`: inspect a non-default Codex home.
- `--index-path /path/to/index.sqlite`: include the derived search-index path in future backup/reindex previews.
- `--ids id-a,id-b`: pass selected ids as a comma-separated list.
- `--process-check warn|strict|skip`: control best-effort Codex process detection. `warn` is the default and reports running Codex processes as warnings. `strict` reports them as failed preflight checks for future apply readiness. `skip` records the process check as unknown for tests and CI.
- `--skip-process-check`: shorthand for `--process-check skip`.
- `--json`: accepted for explicit machine-readable CLI usage. Output is always JSON.

The command requires at least one selected thread id. It does not plan broad or implicit restore batches.

## API

The local web app exposes:

```text
POST /api/restore/plan
```

Request body:

```json
{
  "selectedThreadIds": ["thread-a", "thread-b"],
  "processCheck": "warn"
}
```

`processCheck` may be `warn`, `strict`, or `skip`. `skipProcessCheck: true` is also accepted for test and CI callers.

Because this is a non-GET local API route, requests must include:

```text
X-Codex-Archiver-Intent: local-api
```

When an `Origin` header is present, it must be a localhost origin. The endpoint is still dry-run only, but it follows the same explicit local-intent guard as other non-GET API routes.

## Plan Classifications

Each selected id becomes one plan item:

- `archived-sqlite-thread`: SQLite marks the thread archived and an archived rollout file exists. A future apply phase can propose unarchive/relink actions after backup.
- `jsonl-only-archived-thread`: archived JSONL exists without a SQLite row. A future apply phase can propose insert/reindex actions.
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
- `reportPreview` describing the future machine-readable restore apply report schema, planned report path, and undo/audit fields. Planning never writes the report.
- Per-thread `futureActions`, `backupPreview`, and `mutationPreview` arrays.
- Per-thread `plannedPaths` and `validations` for source evidence and active/archive target conflict checks.

A future apply phase must create timestamped backups before mutation, use a transaction-backed SQLite update plan, keep cache/index state under `~/.cache/codex-archiver`, and emit a machine-readable restore report.

## Preflight Checks

Preflight is intentionally non-mutating. It is suitable for deciding whether a future apply operation should be blocked, but planning still returns a full report even when checks fail.

- `selected-ids-present`: fails when a selected id is no longer present in the current scan.
- `rollout-sources-exist`: fails when SQLite or scan evidence references a missing rollout/session JSONL file.
- `target-path-conflicts`: fails when a planned active/archive target path already exists outside the selected thread evidence.
- `codex-processes-closed`: uses best-effort process detection for Codex Desktop, app-server, and codex processes. It is `warning` in default mode when matches are found, `failed` in `strict` mode, and `unknown` when skipped or unavailable.

Process detection is best-effort and cross-platform-ish: macOS/Linux use `ps`, Windows uses `tasklist`. A future apply phase should require the user to close Codex and re-run preflight immediately before mutation.

## Backup and Report Preview

The planned backup root is deterministic for the selected IDs and plan timestamp:

```text
~/.cache/codex-archiver/backups/restore-<timestamp>-<selectionhash>
```

The manifest previews files a future apply would need to back up, including `state_5.sqlite`, `session_index.jsonl` when present, affected rollout/session files, relevant target paths when they already exist, and the derived search index path. Missing files remain visible in the preview with `exists: false`; planning does not create directories or files.
