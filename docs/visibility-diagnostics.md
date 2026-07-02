# Visibility Diagnostics

Planning notation: `M2/M3-BRIDGE-VIS`

Parent milestone: `M2: Indexed search and diagnostics`

`codex-archiver diagnose visibility` compares local Codex thread evidence with visibility surfaces that may or may not be available on the current machine.

The command and web API are read-only with respect to `~/.codex`. They may rebuild the derived search index under `~/.cache/codex-archiver`, but they do not restore, archive, unarchive, or rewrite Codex session files.

## Evidence Buckets

Each thread report keeps these states separate:

- `activeInLocalStorage`: at least one source path is under `~/.codex/sessions`.
- `archivedInLocalStorage`: at least one source path is under `~/.codex/archived_sessions`.
- `rolloutFileExists`: the scan found a local rollout/session JSONL file.
- `rolloutFileMissing`: SQLite references a rollout/session file that was not found.
- `sqlitePresent`: the thread came from Codex SQLite state.
- `sessionIndexPresent`: the thread id was found in `session_index.jsonl`, or `null` when that file was unavailable.
- `indexedPresent`: the thread id was found in the derived `codex-archiver` search index.
- `codexResumeVisible`: the thread matched `codex resume --all --include-non-interactive`, or `null` when the probe was skipped, unavailable, failed, or timed out.
- `appServerVisible`: the thread matched app-server `/thread/list` pagination, or `null` when the probe was skipped, unavailable, failed, or timed out.

## Probe Behavior

`codex resume --all --include-non-interactive` runs with a timeout and plain terminal environment. Command-not-found, nonzero exits, and timeouts are recorded as probe diagnostics instead of failing the full report.

The app-server probe is only attempted when `--app-server-url` or `CODEX_ARCHIVER_CODEX_APP_SERVER_URL` is set. It reads `/thread/list` pages with a small page limit and stops after a bounded number of pages. HTTP errors and timeouts are recorded as probe diagnostics.

## API

The local web app exposes:

```text
GET /api/visibility
```

Query parameters:

- `timeoutMs`: timeout for live probes.
- `codexResume=0`: skip the `codex resume` probe.
- `appServer=0`: skip the app-server probe.
- `appServerUrl=http://127.0.0.1:PORT`: app-server base URL.
- `includeThreads=0`: return summary/probe diagnostics without the per-thread detail array.
