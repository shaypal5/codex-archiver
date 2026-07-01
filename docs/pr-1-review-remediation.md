# PR 1 Review Remediation

This note records the self-review findings for the initial read-only scanner PR and the concrete fixes applied before merge.

## 1. Do not call locally indexed threads "viewable"

Recommendation: avoid claiming that a thread is visible in Codex Desktop unless the tool verifies Desktop/app-server visibility directly.

Fix: rename the scanner status and first-screen badge from `viewable` to `active`. In this PR, `active` means the thread has an unarchived SQLite row and an existing rollout file. A later diagnostic pass can add true Desktop visibility checks through `codex resume` or app-server `thread/list` pagination.

## 2. Make content search schema-aware

Recommendation: do not recursively scrape every string from rollout JSONL. That mixes session metadata, system/developer instructions, tool calls, tool output, and transcript text into one noisy field.

Fix: build previews and content search text only from `response_item` entries whose payload is a `message` with role `user` or `assistant`, and only from `input_text` / `output_text` content items. Skip developer/system-style messages, session metadata, event messages, tool calls, and command output.

## 3. Do not report fake message counts

Recommendation: either remove the message count column or count real transcript messages only.

Fix: `messageCount` now counts only user/assistant `response_item` messages included by the schema-aware transcript extractor.

## 4. Establish local API safety before restore work

Recommendation: set the server safety pattern while the API is still read-only, before future endpoints mutate `~/.codex`.

Fix: non-GET API requests now require `X-Codex-Archiver-Intent: local-api` and reject non-local browser origins when an `Origin` header is present. Future restore endpoints should reuse this guard and add their own explicit confirmation checks.

## 5. Harden static file serving

Recommendation: do not use string-prefix path checks for static files.

Fix: static serving now validates paths with `path.relative`, rejecting parent traversal and absolute escape paths.

## 6. Add scanner fixtures

Recommendation: parser and classification behavior need fixtures before restore logic depends on them.

Fix: add a Node test covering active indexed, archived, restorable JSONL-only, and orphaned SQLite-only records. The fixture also proves transcript previews exclude metadata, developer text, event messages, and tool calls.
