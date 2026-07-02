# PR 5 Review Remediation

## Review stance

Review the PR yourself, and take an outsider's view: Pretend you're a senior dev and you really don't like the way this PR is implemented; be brutally honest, and aim to make this PR much better with you feedback.

## Recommended actions

What is your recommended action/fix per issue raised? Write it down clearly and in detail, then: Apply your recommendations and push to the PR

## Issues and fixes

1. Blocked planner items advertised backup targets too aggressively.
   - Issue: `missing-rollout-source` and `unsupported` items cannot be applied yet, so showing backup targets at those item levels made the preview look more actionable than it was.
   - Recommended action: Only actionable or diagnostic future paths should add backup pressure. Blocked items should explain what evidence is missing and leave `backupPreview` empty.
   - Applied fix: `missing-rollout-source` and `unsupported` now use empty backup previews while keeping their blocked reasons and evidence.

2. Already-active threads needed a clearer path when the user still cannot see them in Codex UI.
   - Issue: A pure no-op reason could sound dismissive for active local threads that remain hidden by UI hydration or visibility problems.
   - Recommended action: Keep archive restore as a no-op, but explicitly route the user to visibility diagnostics if Codex UI still does not show the thread.
   - Applied fix: The active/no-op reason now names visibility diagnostics as the next path for UI-hidden symptoms.

3. The restore-plan API returned generic 500 errors for malformed JSON.
   - Issue: Bad request bodies are client errors, and reporting them as 500 weakens the local API contract.
   - Recommended action: Return structured 400 responses for invalid JSON and 413 for oversized bodies.
   - Applied fix: Added an `HttpError` path in the server request handler and mapped invalid JSON/body-size failures to specific statuses.

4. The web UI did not surface restore-plan API failures in the panel.
   - Issue: A failed plan request reset the button but left the user without visible context in the restore-plan area.
   - Recommended action: Catch planner request failures and render the error in the existing panel without adding any apply action.
   - Applied fix: The UI now renders a failure note and restores button state.

5. Review fixes needed targeted regression coverage.
   - Issue: The first test pass covered the main happy-path classifications but did not directly lock the API error and blocked-preview semantics.
   - Recommended action: Add assertions for missing-source backup previews, active visibility guidance, and malformed JSON handling.
   - Applied fix: Extended restore tests to cover those cases.
