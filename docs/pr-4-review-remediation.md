# PR #4 Self-Review Remediation

Review stance: "Review the PR yourself, and take an outsider's view: Pretend you're a senior dev and you really don't like the way this PR is implemented; be brutally honest, and aim to make this PR much better with you feedback."

## Issues Raised

1. The first implementation still allowed app-server JSON text to participate in `probeVisibility`. That meant an unrelated app-server row with the same title or cwd as a local thread could mark the local thread visible even when the IDs did not match.

2. Pagination cursor extraction was too broad. A recursive search for any nested `cursor`-like key could accidentally pick up an unrelated nested cursor field and drive `/thread/list` pagination incorrectly.

3. The tests proved many happy and failure paths, but they did not explicitly prove that app-server visibility is exact-ID only. That left the most important false-positive guard implicit.

## Recommended Actions

1. Make app-server visibility exact-ID only. Keep `codex resume` text fallback behavior, but do not use app-server title/cwd JSON as fallback evidence.

2. Replace recursive cursor discovery with explicit path candidates under known response envelopes and pagination containers, such as `result`, `payload`, `data`, `pagination`, `pageInfo`, and `meta`.

3. Add a regression test where the app-server returns an unrelated thread ID with a title/cwd matching a local thread, and assert the local thread remains `appServerVisible: false`.

## Applied Changes

- App-server probe now returns an empty `searchableText` field, so `probeVisibility` can only mark app-server visibility from extracted thread IDs.
- Cursor and `hasMore` extraction now uses explicit response/pagination paths instead of arbitrary deep recursion.
- Added exact-ID-only classification coverage in `src/visibility.test.ts`.
- Updated README and visibility diagnostics docs to document exact-ID app-server matching.
