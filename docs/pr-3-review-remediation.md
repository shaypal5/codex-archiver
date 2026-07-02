# PR 3 Review Remediation

Review stance:

> Review the PR yourself, and take an outsider's view: Pretend you're a senior dev and you really don't like the way this PR is implemented; be brutally honest, and aim to make this PR much better with you feedback.

Second step:

> What is your recommended action/fix per issue raised? Write it down clearly and in detail, then: Apply your recommendations and push to the PR

## Issues Raised

1. The initial `/api/visibility` response always returned full per-thread diagnostics. That is wasteful for the web panel, which only renders summary counts and probe status, and it scales poorly on large local histories.

2. `session_index.jsonl` matching was too dependent on thread ids. If Codex records a session-index row with rollout path evidence but no id, the diagnostics would incorrectly mark that thread absent from the session index.

3. The `codex resume` timeout classifier was too narrow. Node can surface child-process timeouts through more than one field, so a real timeout could be reported as a generic failure.

## Recommended Actions

1. Add a summary-only response mode to visibility diagnostics. Keep full thread details available for CLI/API callers that need them, but have the web panel request only summary/probe data.

2. Parse candidate rollout paths from `session_index.jsonl`, resolve relative paths against `codexHome`, and classify session-index presence by either id or source path. Cover the path-only case in tests.

3. Broaden child-process timeout detection to include the timeout-shaped error fields Node exposes in addition to killed/signal fields.

## Applied Changes

1. Added `includeThreads` support to `diagnoseVisibility`, wired `includeThreads=0` through `/api/visibility`, and changed the web UI to use the summary-only path.

2. Added session-index path extraction and path-based matching, then updated the fixture test so the archived thread is session-index matched by rollout path rather than id.

3. Broadened `codex resume` timeout detection and kept timeout probe status distinct from generic failed/unavailable statuses.
