# Initial validation record — 2026-09-20

This file distinguishes execution evidence from API/document review. Update it after running the real integrations; do not overwrite the limitations with an unverified success claim.

## Verified GitHub Actions run

[Check run 35504341556](https://github.com/vinsonws/jev-page-tester/actions/runs/35504341556) completed successfully for commit `285fb8cd8ddb91a7e71339358dae0a4f2f430a5b` on 2026-09-20.

- Clean Ubuntu runner, Node.js 22.23.2, npm 10.9.8, declared pinned dependencies and downloaded Chromium 140.0.7339.186.
- Dependency installation and TypeScript/extension syntax checks passed.
- 16 unit/stdio/extension-registration tests passed; 0 skipped.
- 10 normal browser tests passed; 0 skipped. `QA_DOM_ONLY` was not enabled. These exercised actual local HTTP navigation, HTTP 503 observation, DOM interactions, replay, cancellation and other test cases.
- The scripted headless demo completed successfully and reported the intended duplicate-submit anomaly.
- This validates the browser/runner test paths on the pinned dependencies. It does NOT validate real Jev calls, Muse Spark, native OMP, proxy transport, arbitrary user apps or renderer crash detection.

## Executed in this working copy — 2026-09-21 (macOS, Node 24.20.0, ARM64)

Recorded for commit `dc6204b` + the lockfile commit. These are local runs, not CI.

- `npm install`: succeeded against the pinned `package.json` and generated `package-lock.json` (lockfileVersion 3, 8 packages); `npm ci` then reproduced the same tree from that lockfile.
- `npx playwright install chromium`: downloaded Chromium 140.0.7339.186 (playwright build v1193), matching the CI build.
- `npm run typecheck`: passed (TypeScript 5.8.3).
- `npm test`: 16 unit/stdio/extension-registration tests passed, 0 skipped.
- `npm run test:browser`: 10 browser tests passed, 0 skipped, `QA_DOM_ONLY` unset — real local HTTP navigation, HTTP 503, burst-submit + replay, pageerror, stale target, cancellation, screenshot opt-in, deadline, model outage.
- `npm run demo -- --headless`: completed with `status: anomaly`, the intended duplicate-submit finding. Artifacts removed afterward.
- `npm run check`: typecheck + unit + browser all green in one pass.

## Executed against the real official Jev service — 2026-09-21

Operator-supplied `TYPESAFE_API_KEY` present; these are billable live runs, not mocked.

- `npm run demo -- --headless --live` on the intentional fault fixture:
  - `mode: official-jev`, `status: anomaly`.
  - 3 real decisions recorded in `events.jsonl` with model, probability and token usage:
    `jev-1.13.0: a0, p=0.91, input_tokens=1019` → `jev-1.13.0: a2, p=0.71, input_tokens=1043` → `jev-1.13.0: done, p=0.83, input_tokens=1072`.
  - The supervisor-supplied `count` assertion failed: 3 Save clicks produced 3 `#records li` entries instead of 1. Correctly reported as `anomaly`, not PASS.
  - `run.json` requested model `jev-1.13.0`; the decision events report the model name returned by the service.
  - Artifacts written under `runs/` (gitignored) and removed afterward.
- Native OMP 18.2.6 with the local extension (`omp -e .../.omp/extensions/qa.js`), `-p` non-interactive, against the local fixture on `127.0.0.1:4173`:
  - `qa_open` + `qa_inspect`: session opened, title `Jev QA fault fixture`, 5 visible controls, no events.
  - `qa_explore` end-to-end: real Jev chose `a0` fill (p=0.66), `a1` click (p=0.99), `done` (p=0.89); 2 actions executed; supervisor-supplied count assertion **satisfied** (1 record).
  - `qa_replay` on that run with `resetConfirmed: true`: new session, 2 actions replayed, `replayOf` set, assertion re-checked, and no model decisions in `events.jsonl` (only `replay_source` + `assertion_satisfied`).
  - `qa_close` completed normally; no orphaned `dist/src/worker.js` process or Playwright-managed browser remained.
  - Verified separately that the error path works: `qa_open` against an unreachable origin returned `net::ERR_CONNECTION_REFUSED` without creating a session.

## Still not verified

Real Jev calls are now verified locally (single-fixture scope only). Remaining gaps:

- Muse Spark as an interactive OMP session — only the non-interactive `omp -p` supervisor path was exercised; no interactive Muse-driven multi-mission investigation.
- Interactive OMP commands: `/qa-stop` is registered by the extension but was not invoked through an interactive TUI session. It was not exercised in the `-p` path, which exposes tools only, not slash commands.
- `QA_JEV_PROXY` proxy transport through the official SDK.
- Real renderer process crash (`crash`), iframe/Shadow DOM/canvas/file upload/multi-tab/visual regression.
- Arbitrary user applications, production data, and any backend state reset.
- Probability quality of `jev-1.13.0` beyond these three/five decisions; `minProbability=0.65` remains an uncalibrated engineering default.

## Executed in the creation environment

- `npm run typecheck`: passed with TypeScript 5.8.3 / Node.js 22.16.0.
- `npm test`: 16 unit/stdio/extension-registration tests passed, without API credentials.
- `QA_DOM_ONLY=1 QA_BROWSER_EXECUTABLE=/usr/bin/chromium npm run test:browser`: 9 browser DOM tests passed; 1 HTTP test explicitly skipped.
- DOM tests used an actual Chromium renderer with `page.setContent` and the synthetic fixture, not screenshots or a simulated DOM library. They exercised filling, consecutive clicks, duplicate-record detection, saved assertion replay, pageerror capture, stale identity rejection, cancellation, budgets and screenshot opt-in.
- The existing environment's Playwright driver was `1.57.0-beta-1764944708000`; it was used via a local, uncommitted symlink. The subsequent GitHub Actions run above verified the pinned npm Playwright 1.55.1 dependency separately. No bundled runtime, symlink or dependency source is shipped in this repository.

## Creation-environment limitations and remaining integration gaps

- The container cannot resolve/reach npm, so `npm install`, lockfile generation and a clean install were not executed there. A lockfile was later generated and committed from a networked machine; `npm ci` was verified against it. Clean installation was also verified in GitHub Actions.
- The system browser has a managed URLBlocklist that forbids URL navigation. A normal local HTTP demo failed with `ERR_BLOCKED_BY_ADMINISTRATOR`. That policy was not modified. Production navigation, HTTP instrumentation and request interception are **not** validated by DOM-only mode.
- The TypeSafe SDK boundary was checked against official 0.6.0 source/docs and exercised with an injected client-shaped test double. The npm SDK itself, real API keys, billing, probability quality and proxy transport were not exercised.
- The OMP extension factory/tool registration was tested with a mock host. Native OMP loading and an actual Muse Spark tool-call round trip were not run.
- No real renderer process crash, hard-hung renderer, user app, remote service or production data was tested.

## Reproduce on a normal development machine

```sh
npm install
npx playwright install chromium
npm run typecheck
npm test
npm run test:browser
npm run demo -- --headless
```

Leave `QA_DOM_ONLY` unset for normal browser tests. DOM-only mode exists solely for restricted offline testing; it is never read by the production worker and is not an automatic fallback. Its logical URL is fixture metadata, not a real navigation.

Then configure your official TypeSafe key and run `npm run demo -- --headless --live`. Finally run the five tools through Muse Spark in native OMP and record the exact OMP/Muse/provider versions, model response version, network environment and results.

CI runs normal browser tests on a clean runner without API secrets. The successful run above was verified from its job steps and logs; later commits/runs require their own verification.
