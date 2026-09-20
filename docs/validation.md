# Initial validation record — 2026-09-20

This file distinguishes execution evidence from API/document review. Update it after running the real integrations; do not overwrite the limitations with an unverified success claim.

## Executed in the creation environment

- `npm run typecheck`: passed with TypeScript 5.8.3 / Node.js 22.16.0.
- `npm test`: 16 unit/stdio/extension-registration tests passed, without API credentials.
- `QA_DOM_ONLY=1 QA_BROWSER_EXECUTABLE=/usr/bin/chromium npm run test:browser`: 9 browser DOM tests passed; 1 HTTP test explicitly skipped.
- DOM tests used an actual Chromium renderer with `page.setContent` and the synthetic fixture, not screenshots or a simulated DOM library. They exercised filling, consecutive clicks, duplicate-record detection, saved assertion replay, pageerror capture, stale identity rejection, cancellation, budgets and screenshot opt-in.
- The existing environment's Playwright driver was `1.57.0-beta-1764944708000`; it was used via a local, uncommitted symlink. The repository's pinned npm Playwright 1.55.1 dependency still needs a clean-install run. No bundled runtime, symlink or dependency source is shipped in this repository.

## Not verified here

- The container cannot resolve/reach npm. `npm install` / lockfile generation and a clean install of the declared dependencies were not executed.
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

The proposed CI workflow runs normal browser tests on a clean runner without API secrets. A workflow file existing in GitHub is not evidence that the run passed; inspect its actual result.
