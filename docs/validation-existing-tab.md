# Existing-tab validation — 2026-09-21

This record concerns the new official-extension connector, not a retroactive claim about the
initial CDP-isolated attach implementation. Historical operator/CI records remain in validation.md.

## Executed evidence

[GitHub Actions run 35560799322](https://github.com/vinsonws/jev-page-tester/actions/runs/35560799322)
completed successfully for code commit `40d869efad3edc69f568dcc08487ee93e64889fc`.
Job `106213174831` steps and logs were inspected, not inferred from workflow YAML.

Environment: clean Ubuntu 24.04.5 runner, Node.js 22.23.2, npm 10.9.8,
Chromium 140.0.7339.186 (root Playwright 1.55.1), official @playwright/mcp 0.0.82 and MCP SDK 1.25.2.
The MCP package uses its own pinned Playwright runtime; no private runtime imports are used.

- Dependency installation and TypeScript/OMP extension syntax checks passed.
- 20 unit/IPC/configuration/fingerprint tests passed, no skips.
- 19 real-browser tests passed, no skips; QA_DOM_ONLY was unset.
- 2 installed-MCP integration tests passed, no skips.
- Scripted demo detected its intentional duplicate-submit defect (status anomaly).

New browser coverage includes existing HTTP-only synthetic cookie/localStorage and unfinished
input retention, unchanged viewport/no navigation, fixed target after another tab becomes active,
page-only routing and removal, page closure without retargeting, cancellation, action budgets,
mode-aware replay with initial-state rejection, and release even when artifact cleanup throws.

The MCP integration exercises the installed official createConnection + SDK in-memory protocol +
initPage hook + a REAL CDP Page. It changes the operator-owned fixture's input, verifies no navigation,
and verifies that disconnect ends the CDP client connection while the original page stays usable.
A second test cancels an unfinished connection and checks its worker-retirement classification.

The interactive extension chooser is replaced ONLY in these CI integration tests by the public
contextGetter seam. This is deliberately labelled in source and test output. The production
worker does not supply contextGetter and requests the real extension authorization.

## Not verified by this run

- Chrome Web Store installation, extension popup/chooser clicks, extension revocation UI,
  multi-client tab-group behavior or compatibility with the operator's installed extension version.
- Full Muse Spark -> native interactive OMP -> actual extension approval -> official Jev calls.
- The user's browser, private application, actual login service or production accounts.
- Proxy transport, real renderer crash/hang, all pending-browser-command cancellation races,
  complete SW/WebSocket interception or non-DOM controls.

The cookie is synthetic; no real credentials were used. Browser tests are deterministic scripted
fixtures, not Jev inference. Earlier operator-reported live Jev/OMP tests in validation.md predate
this connector and do not establish that the new full chain was executed.

## Lockfile and follow-up verification

The same clean runner generated the resolved lockfile. It is committed as Git blob
`2ed6d2f3594a578b9200436125bc651467f8f08b`. Final CI uses npm ci and read-only repository permissions;
the one-off lockfile-generation job is not part of the final workflow. Inspect each later run's
actual result; the success above does not automatically certify later commits.

## Manual acceptance checklist

With the official extension installed in a test Chrome profile, use a synthetic authenticated
page and an unfinished form. Enable existing-tab locally, approve ONE tab, inspect before acting,
then run a bounded Jev mission and close it. Confirm no reload/new tab/resize at acquisition,
retained authentication/input, fixed target when changing active tabs, and manual usability after
release. Also exercise rejected approval, revoked approval, cancelled pending approval, stopped
active missions and replay with restored vs mismatched initial state. Record exact OMP, browser,
extension, MCP and Jev versions and distinguish observed results from assumptions.
