# codex-archiver

A local browser and restoration tool for old, archived, hidden, and hard-to-find Codex Desktop threads.

## Status

Early scaffold. Browsing, scanning, diagnostics, indexing, restore planning, and restore undo preview are read-only with respect to `~/.codex`. The intentionally mutating paths are limited to `codex-archiver restore apply` and confirmation-gated `codex-archiver restore undo`, both after explicit artifact selection, preflight, backup validation, timestamped backups, machine-readable reports, and verification.

## Usage

```bash
npm install
npm run build
npm start
```

Then open:

```text
http://127.0.0.1:8976
```

The first screen shows summary badges for total threads, total projects, and active indexed threads, followed by separate filters for thread names, content previews, project paths, and restoration status.

The web UI also includes a visibility diagnostics panel. It compares the local scanned/indexed thread universe with best-effort Codex visibility surfaces when they are available, without mutating `~/.codex`.

The browser also lets you select specific threads and generate a dry-run restore plan. The plan previews classifications, preflight checks, blockers, warnings, backup manifest entries, restore report fields, confirmation token, and mutation targets. Apply is intentionally CLI/API-gated for now.

## CLI

```bash
npm run scan
```

The scanner reads:

- `~/.codex/state_5.sqlite`
- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.jsonl`

Use a non-default Codex home with:

```bash
node dist/cli.js serve --codex-home /path/to/.codex
node dist/cli.js scan --codex-home /path/to/.codex
```

## Search Index

The web UI uses a persistent local SQLite/FTS5 search index at:

```text
~/.cache/codex-archiver/index.sqlite
```

Build or refresh it with:

```bash
node dist/cli.js index rebuild
```

Inspect it with:

```bash
node dist/cli.js index status
```

Clear it with:

```bash
node dist/cli.js index clear
```

See [docs/search-index.md](docs/search-index.md) for details.

## Visibility Diagnostics

Run read-only visibility diagnostics with:

```bash
node dist/cli.js diagnose visibility
```

The report keeps evidence sources separate for each indexed/scanned thread:

- active rollout files under `~/.codex/sessions`
- archived rollout files under `~/.codex/archived_sessions`
- missing rollout/session files referenced by SQLite
- SQLite `threads` presence
- `session_index.jsonl` presence when the file exists
- persistent search-index presence under `~/.cache/codex-archiver`
- visibility through `codex resume --all --include-non-interactive` when the command succeeds
- visibility through a Codex app-server `/thread/list` endpoint when configured

Live Codex probes are best-effort and time-limited. Use these flags when needed:

```bash
node dist/cli.js diagnose visibility --timeout-ms 5000
node dist/cli.js diagnose visibility --no-codex-resume --no-app-server
node dist/cli.js diagnose visibility --app-server-url http://127.0.0.1:PORT
```

The app-server URL may also be set with `CODEX_ARCHIVER_CODEX_APP_SERVER_URL`.
The app-server `/thread/list` parser accepts common `payload` / `data` / `result` envelopes, several thread-id aliases, and bounded cursor pagination. App-server visibility uses exact thread-id matches only. Shape mismatches, malformed thread objects, repeated cursors, page-limit stops, unavailable servers, and timeouts are reported as probe status or warnings instead of failing the full diagnostics report.

## Restore Planning

Create an explicit dry-run restore plan for selected thread ids with:

```bash
node dist/cli.js restore plan THREAD_ID...
node dist/cli.js restore plan --ids thread-a,thread-b --json
node dist/cli.js restore plan THREAD_ID --process-check strict
node dist/cli.js restore plan THREAD_ID --skip-process-check
```

The planner classifies selected threads as archived SQLite, JSONL-only archived, UI-hidden active, missing source, already active, not found, or unsupported. Planning includes impact, preflight, backup manifest, restore report previews, and a confirmation token, but it never creates backups or mutates `~/.codex`.

Apply the current safe subset with:

```bash
node dist/cli.js restore plan THREAD_ID --process-check warn
node dist/cli.js restore apply THREAD_ID --confirm-token restore-...
```

`restore apply` recomputes the plan immediately before mutation, requires the confirmation token or phrase from the plan, blocks on any non-passing preflight check, creates a timestamped backup root under `~/.cache/codex-archiver/backups`, writes a machine-readable report, then verifies by rescanning. M4 apply supports only archived SQLite threads with existing archived JSONL evidence. JSONL-only archived threads and UI-hidden active threads remain diagnostic-only.

Preview rollback from an apply backup/report artifact with:

```bash
node dist/cli.js restore undo --report /path/to/restore-report.json
node dist/cli.js restore undo --backup-root /path/to/backup-root
```

The preview validates the report schema, backup manifest, backup file hashes/sizes, target paths, and Codex process preflight, then shows target restore/remove actions plus an undo confirmation token. Confirmed undo creates a fresh rollback-safety backup, restores backed files, removes apply-created active-session files recorded in the apply report, rebuilds the derived search index, writes a machine-readable undo report, and verifies by rescanning.

See [docs/restore-planning.md](docs/restore-planning.md) for the `M3-RESTORE-PLAN`, `M3-PREFLIGHT-BACKUP-PREVIEW`, `M4-RESTORE-APPLY-BACKUPS`, and `M4-RESTORE-UNDO-BACKUPS` contracts, CLI/API details, and safety boundaries.

## CI

Pull requests run GitHub Actions CI with:

- `npm ci`
- `npm run check`
- `npm test`

## Safety

The only supported `~/.codex` mutation paths are explicit restore apply and explicit restore undo from an existing backup/report artifact. Do not run apply or confirmed undo while Codex Desktop or related Codex processes are open. Keep apply backup roots, apply reports, undo safety backups, and undo reports until the restored state is confirmed healthy.
