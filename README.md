# codex-archiver

A local browser and restoration tool for old, archived, hidden, and hard-to-find Codex Desktop threads.

## Status

Early scaffold. Browsing, scanning, diagnostics, indexing, restore planning, and restore undo preview are read-only with respect to `~/.codex`. The intentionally mutating paths are limited to `codex-archiver restore apply` and confirmation-gated `codex-archiver restore undo`, both after explicit artifact selection, preflight, backup validation, timestamped backups, machine-readable reports, and verification.

## Usage

Use the local browser directly from a checkout:

```bash
npm install
npm run build
npm start
```

Then open:

```text
http://127.0.0.1:8976
```

The first screen shows summary badges for total threads, total projects, and local active threads, followed by separate filters for thread names, content previews, project paths, and restoration status.

`Local active` means the thread has unarchived local Codex state plus an active rollout file. It does not prove that Codex Desktop currently shows the thread in the sidebar; use visibility diagnostics for that narrower app-level check.

The thread table can be sorted by local status, project path, update time, or message count. Clicking a table row opens a floating transcript viewer that reads the underlying rollout JSONL and shows user/assistant messages in chronological order from the top.

On startup, the browser renders thread results from the existing local index first, then refreshes index freshness and diagnostics in the background. Visibility diagnostics are intentionally user-triggered because they may call slow or unavailable Codex surfaces.

The web UI also includes a visibility diagnostics panel. It compares the local scanned/indexed thread universe with best-effort Codex visibility surfaces when they are available, without mutating `~/.codex`.

The browser also lets you select specific threads and generate a dry-run restore plan. The plan previews classifications, preflight checks, blockers, warnings, backup manifest entries, restore report fields, confirmation token, and mutation targets. Apply is intentionally CLI/API-gated for now.

## Install

From a local checkout during development:

```bash
npm install
npm run build
npm link
codex-archiver --help
codex-archiver serve
```

From a packed tarball, without publishing to npm:

```bash
npm pack
npm install -g ./codex-archiver-0.1.0.tgz
codex-archiver --version
codex-archiver serve
```

`npm pack` runs the TypeScript build through `prepack`. Package artifacts include the compiled CLI/server, top-level `web/` assets used by `codex-archiver serve`, README, license, and user-facing docs. Source files, tests, GitHub workflow files, local worktrees, package smoke-test scripts, and PR-process notes are intentionally excluded from the install artifact.

Run the package smoke test before release handoff:

```bash
npm run package:smoke
```

The smoke test creates a real package tarball in a temporary directory, installs it into a temporary consumer project, verifies the `codex-archiver` bin, checks `--help` and `--version`, starts the packaged `serve` command, and verifies required runtime/docs files are present while private/test-only files are absent. Publishing to npm is not automated by this project yet.

See [docs/install-release.md](docs/install-release.md) for the release checklist and package artifact contract.

## CLI

```bash
codex-archiver scan
```

The scanner reads:

- `~/.codex/state_5.sqlite`
- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.jsonl`

Use a non-default Codex home with:

```bash
codex-archiver serve --codex-home /path/to/.codex
codex-archiver scan --codex-home /path/to/.codex
```

## Search Index

The web UI uses a persistent local SQLite/FTS5 search index at:

```text
~/.cache/codex-archiver/index.sqlite
```

Build or refresh it with:

```bash
codex-archiver index rebuild
```

Inspect it with:

```bash
codex-archiver index status
```

Clear it with:

```bash
codex-archiver index clear
```

See [docs/search-index.md](docs/search-index.md) for details.

## Visibility Diagnostics

Run read-only visibility diagnostics with:

```bash
codex-archiver diagnose visibility
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
codex-archiver diagnose visibility --timeout-ms 5000
codex-archiver diagnose visibility --no-codex-resume --no-app-server
codex-archiver diagnose visibility --app-server-url http://127.0.0.1:PORT
```

The app-server URL may also be set with `CODEX_ARCHIVER_CODEX_APP_SERVER_URL`.
The app-server `/thread/list` parser accepts common `payload` / `data` / `result` envelopes, several thread-id aliases, and bounded cursor pagination. App-server visibility uses exact thread-id matches only. Shape mismatches, malformed thread objects, repeated cursors, page-limit stops, unavailable servers, and timeouts are reported as probe status or warnings instead of failing the full diagnostics report.

## Restore Planning

Create an explicit dry-run restore plan for selected thread ids with:

```bash
codex-archiver restore plan THREAD_ID...
codex-archiver restore plan --ids thread-a,thread-b --json
codex-archiver restore plan THREAD_ID --process-check strict
codex-archiver restore plan THREAD_ID --skip-process-check
```

The planner classifies selected threads as archived SQLite, JSONL-only archived, UI-hidden active, missing source, already active, not found, or unsupported. Planning includes impact, preflight, backup manifest, restore report previews, and a confirmation token, but it never creates backups or mutates `~/.codex`.

Apply the current safe subset with:

```bash
codex-archiver restore plan THREAD_ID --process-check warn
codex-archiver restore apply THREAD_ID --confirm-token restore-...
```

`restore apply` recomputes the plan immediately before mutation, requires the confirmation token or phrase from the plan, blocks on any non-passing preflight check, creates a timestamped backup root under `~/.cache/codex-archiver/backups`, writes a machine-readable report, then verifies by rescanning. M4 apply supports only archived SQLite threads with existing archived JSONL evidence. JSONL-only archived threads and UI-hidden active threads remain diagnostic-only.

Preview rollback from an apply backup/report artifact with:

```bash
codex-archiver restore undo --report /path/to/restore-report.json
codex-archiver restore undo --backup-root /path/to/backup-root
```

The preview validates the report schema, backup manifest, backup file hashes/sizes, target paths, and Codex process preflight, then shows target restore/remove actions plus an undo confirmation token. Confirmed undo creates a fresh rollback-safety backup, restores backed files, removes apply-created active-session files recorded in the apply report, rebuilds the derived search index, writes a machine-readable undo report, and verifies by rescanning.

See [docs/restore-planning.md](docs/restore-planning.md) for the `M3-RESTORE-PLAN`, `M3-PREFLIGHT-BACKUP-PREVIEW`, `M4-RESTORE-APPLY-BACKUPS`, and `M4-RESTORE-UNDO-BACKUPS` contracts, CLI/API details, and safety boundaries.

## Planning

`M5-PACKAGING-RELEASE-HARDENING` under milestone `M5: Packaging and release hardening` covers package metadata, installable artifacts, package smoke validation, CI release checks, and install/release documentation. It does not introduce npm publishing credentials or automated publishing.

## CI

Pull requests run GitHub Actions CI with:

- `npm ci`
- `npm run check`
- `npm test`
- `npm run package:smoke`

## Safety

The only supported `~/.codex` mutation paths are explicit restore apply and explicit restore undo from an existing backup/report artifact. Do not run apply or confirmed undo while Codex Desktop or related Codex processes are open. Keep apply backup roots, apply reports, undo safety backups, and undo reports until the restored state is confirmed healthy.

The package never stores cache/index state under `~/.codex`; derived search state and backup artifacts stay under `~/.cache/codex-archiver` unless explicitly overridden. `~/.codex` remains the source of truth.
