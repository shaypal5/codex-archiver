# Persistent Search Index

`codex-archiver` keeps its own read-only cache of Codex thread metadata and transcript search text.

Default location:

```text
~/.cache/codex-archiver/index.sqlite
```

The index is derived from local Codex storage:

- `~/.codex/state_5.sqlite`
- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.jsonl`

The indexer does not mutate `~/.codex`.

The index is sensitive private data. It stores searchable thread titles and user/assistant transcript text copied from local Codex history. By default the cache directory is restricted to `0700` and the SQLite database is restricted to `0600`.

## Commands

Rebuild the index:

```bash
codex-archiver index rebuild
```

Inspect index status:

```bash
codex-archiver index status
```

Search from the CLI:

```bash
codex-archiver index search --title budget
codex-archiver index search --content "restore archived"
codex-archiver index search --cwd /path/to/project --status archived --limit 100 --offset 0
```

Clear the local index:

```bash
codex-archiver index clear
```

Use a custom cache path:

```bash
codex-archiver index rebuild --index-path /tmp/codex-archiver.sqlite
codex-archiver serve --index-path /tmp/codex-archiver.sqlite
```

## Search Behavior

The index stores thread metadata in a normal SQLite table and uses SQLite FTS5 virtual tables for title and transcript content search.

Transcript search is intentionally schema-aware. It indexes user and assistant message text only, and skips session metadata, injected environment context, developer messages, event messages, tool calls, and tool output. This keeps search focused on what the user asked and what Codex answered.

Searches are paginated. The default limit is `100`, the maximum limit is `500`, and responses include `totalMatches`, `limit`, and `offset`.

## Freshness

The index stores a source fingerprint derived from `state_5.sqlite`, `sessions/**/*.jsonl`, and `archived_sessions/**/*.jsonl` path/size/mtime metadata. `serve` and `index search` rebuild automatically when the source fingerprint changes or when the cache was built for a different Codex home.

The current `active` status means a thread has an unarchived SQLite row and an existing rollout file. It does not yet prove that Codex Desktop currently shows that thread in the sidebar.
