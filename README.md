# codex-archiver

A local browser and restoration tool for old, archived, hidden, and hard-to-find Codex Desktop threads.

## Status

Early scaffold. The current implementation is read-only: it scans local Codex storage and serves a browser UI, but it does not restore or mutate threads yet.

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
The app-server `/thread/list` parser accepts common `payload` / `data` / `result` envelopes, several thread-id aliases, and bounded cursor pagination. Shape mismatches, malformed thread objects, repeated cursors, page-limit stops, unavailable servers, and timeouts are reported as probe status or warnings instead of failing the full diagnostics report.

## CI

Pull requests run GitHub Actions CI with:

- `npm ci`
- `npm run check`
- `npm test`

## Safety

This first version is intentionally read-only. Restore planning and backup-backed mutation will be added in later PRs.
