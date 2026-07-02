# Restore Planning

Planning notation: `M3-RESTORE-PLAN`

Parent milestone: `M3: Restore planning and safety checks`

`codex-archiver restore plan` creates an explicit dry-run plan for selected thread ids. It is read-only with respect to `~/.codex`: it does not create backups, edit SQLite, rewrite `session_index.jsonl`, move rollout files, or apply restore changes.

## CLI

```bash
node dist/cli.js restore plan THREAD_ID...
node dist/cli.js restore plan --ids thread-a,thread-b --json
```

Useful flags:

- `--codex-home /path/to/.codex`: inspect a non-default Codex home.
- `--index-path /path/to/index.sqlite`: include the derived search-index path in future backup/reindex previews.
- `--ids id-a,id-b`: pass selected ids as a comma-separated list.
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
  "selectedThreadIds": ["thread-a", "thread-b"]
}
```

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
- Per-thread `futureActions`, `backupPreview`, and `mutationPreview` arrays.

A future apply phase must create timestamped backups before mutation, use a transaction-backed SQLite update plan, keep cache/index state under `~/.cache/codex-archiver`, and emit a machine-readable restore report.
