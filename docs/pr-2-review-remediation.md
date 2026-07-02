# PR 2 Review Remediation

This note records the self-review findings for the persistent search index PR and the concrete fixes applied before merge.

## 1. Plaintext private transcript cache

Recommendation: treat the search index as sensitive private data because it duplicates searchable Codex conversation text outside `~/.codex`.

Fix: create the cache directory with mode `0700`, chmod the index database to `0600`, document the privacy implication, and add `codex-archiver index clear` to remove the cache and SQLite sidecar files.

## 2. Giant SQL rebuild script

Recommendation: do not build one in-memory SQL string containing every transcript.

Fix: stream SQL statements into a `sqlite3` process with backpressure handling. The scanner still produces normalized thread records in memory, but the rebuild no longer creates a second giant SQL script containing the full corpus.

## 3. Stale index behavior

Recommendation: do not trust an index solely because it has a `rebuilt_at` timestamp.

Fix: store a source fingerprint derived from `state_5.sqlite`, `sessions/**/*.jsonl`, and `archived_sessions/**/*.jsonl` path/size/mtime metadata. `serve` and `index search` automatically rebuild when the fingerprint changes or when the index was built for a different Codex home.

## 4. Invalid filters

Recommendation: invalid status filters should fail loudly rather than silently widening results.

Fix: CLI status typos now exit with usage code `2`, the HTTP API returns `400`, and the indexer throws for invalid status values.

## 5. Pagination

Recommendation: broad searches should not return the entire corpus by default.

Fix: searches now default to `limit=100`, cap at `500`, support `offset`, and return `totalMatches`, `limit`, and `offset`. The web UI has Previous/Next controls.

## 6. Atomic rebuilds

Recommendation: avoid mutating the live index in place during rebuild.

Fix: rebuilds now write to a temporary SQLite file, validate it by reading stats, chmod it, remove stale sidecars, and atomically rename it over the old index.
