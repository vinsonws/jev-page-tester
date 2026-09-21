import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, fixtureHtml } from '../examples/fixture.js';
import { chromium } from 'playwright';
import { parseConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { BrowserDriver } from '../src/browser.js';
import { Recorder } from '../src/recorder.js';
import { ScriptedDecider } from '../src/demo-decider.js';
import { pause } from '../src/validation.js';
import type { Decider, Config } from '../src/types.js';

const domOnly = process.env.QA_DOM_ONLY === '1';
const openBrowser = (url: string, c: Config, r: Recorder) => domOnly
  ? BrowserDriver.openDomFixture(url, c, r, fixtureHtml) : BrowserDriver.open(url, c, r);
async function setup(decider: Decider) {
  const fixture = await startFixture(); const root = mkdtempSync(join(tmpdir(), 'jev-browser-'));
  const config = parseConfig({ allowedOrigins: [fixture.url], headless: true, settleMs: 150 });
  const runner = new Runner(root, config, decider, openBrowser);
  return { fixture, root, runner, config, close: async () => { await runner.closeAll(); await fixture.close(); rmSync(root, { recursive: true, force: true }); } };
}
const done = () => new ScriptedDecider(c => c.find(a => a.kind === 'done'));

test(`private controls/text excluded; done is not PASS${domOnly ? ' [DOM-only]' : ''}`, async () => {
  const env = await setup(done());
  try {
    const opened = await env.runner.open(env.fixture.url);
    assert.ok(opened.snapshot!.targets.some(t => t.label === 'Title'));
    assert.equal(JSON.stringify(opened.snapshot).includes('password-canary'), false);
    assert.equal(JSON.stringify(opened.snapshot).includes('private-canary'), false);
    const result = await env.runner.explore(opened.sessionId, { objective: 'Observe only' });
    assert.equal(result.status, 'stopped'); assert.equal(result.verdict, 'not_evaluated');
  } finally { await env.close(); }
});
test('burst-submit bug is detected by an independent assertion and replayed without model calls', async () => {
  const decider = new ScriptedDecider((c, i) => i === 0 ? c.find(a => a.kind === 'fill') :
    i === 1 ? c.find(a => a.kind === 'burst_click' && a.target?.label === 'Save') : c.find(a => a.kind === 'done'));
  const env = await setup(decider);
  try {
    const opened = await env.runner.open(env.fixture.url);
    const result = await env.runner.explore(opened.sessionId, { objective: 'Probe duplicate Save', burstClicks: 3,
      inputs: [{ field: 'Title', value: 'test-record' }],
      checks: [{ kind: 'count', selector: '#records li', expected: 1, label: 'One intended record' }] });
    assert.equal(result.status, 'anomaly');
    assert.ok(result.events.some(e => e.kind === 'assertion_failed'));
    const records = JSON.parse(readFileSync(join(result.artifactsDir, 'actions.json'), 'utf8'));
    assert.equal(records.length, 2); assert.equal(records[0].action.value, 'test-record');
    assert.equal(records[1].clickTimesMs.length, 3);
    const calls = decider.calls;
    await assert.rejects(env.runner.replay(opened.sessionId, false), /Reset/);
    const replay = await env.runner.replay(opened.sessionId, true);
    assert.equal(replay.status, 'anomaly'); assert.equal(decider.calls, calls);
  } finally { await env.close(); }
});
test('uncaught application exception is recorded separately from a renderer crash', async () => {
  const env = await setup(new ScriptedDecider(c => c.find(a => a.kind === 'click' && a.target?.label === 'Trigger error')));
  try {
    const opened = await env.runner.open(env.fixture.url);
    const result = await env.runner.explore(opened.sessionId, { objective: 'Trigger known error', maxActions: 1 });
    assert.equal(result.status, 'anomaly'); assert.ok(result.events.some(e => e.kind === 'pageerror' && e.message.includes('fixture:')));
    assert.equal(result.events.some(e => e.kind === 'crash'), false);
  } finally { await env.close(); }
});
test('HTTP 503 is a response event, not a requestfailed event', { skip: domOnly ? 'DOM-only mode cannot verify navigation/network behavior' : false }, async () => {
  const env = await setup(new ScriptedDecider(c => c.find(a => a.kind === 'click' && a.target?.label === 'Trigger server error')));
  try {
    const opened = await env.runner.open(env.fixture.url);
    const result = await env.runner.explore(opened.sessionId, { objective: 'Trigger server error', maxActions: 1 });
    assert.ok(result.events.some(e => e.kind === 'http_5xx'));
    assert.equal(result.events.some(e => e.kind === 'request_failed' && e.message.includes('/fail')), false);
  } finally { await env.close(); }
});
test('model outage never becomes a product failure or a silent scripted fallback', async () => {
  const env = await setup({ decide: async () => { throw new Error('simulated API outage'); } });
  try {
    const opened = await env.runner.open(env.fixture.url);
    const result = await env.runner.explore(opened.sessionId, { objective: 'Explore' });
    assert.equal(result.status, 'model_error'); assert.equal(result.actionsExecuted, 0);
    assert.ok(result.events.some(e => e.kind === 'model_error'));
  } finally { await env.close(); }
});
test('concurrent session writes refused; cancellation closes the managed browser', async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const env = await setup({ decide: async () => { entered(); return new Promise(() => {}); } });
  try {
    const opened = await env.runner.open(env.fixture.url); const controller = new AbortController();
    const operation = env.runner.explore(opened.sessionId, { objective: 'Wait for cancellation' }, controller.signal);
    await ready;
    await assert.rejects(env.runner.inspect(opened.sessionId, false), /busy/);
    controller.abort(new Error('test cancelled'));
    const result = await operation;
    assert.equal(result.status, 'cancelled'); assert.equal(result.actionsExecuted, 0);
    await assert.rejects(env.runner.explore(opened.sessionId, { objective: 'Do not resume' }), /closed/);
  } finally { await env.close(); }
});
test('stale target is not silently replaced with a new matching element', async () => {
  const env = await setup(done()); let driver: BrowserDriver | undefined;
  try {
    const recorder = new Recorder(env.root, env.fixture.url, s => s, 'fixture');
    driver = await openBrowser(env.fixture.url, env.config, recorder);
    const snapshot = await driver.observe(); const target = snapshot.targets.find(t => t.label === 'Save')!;
    await driver.page.locator('[data-testid="save"]').evaluate(el => { el.textContent = 'Changed target'; });
    await assert.rejects(driver.execute({ id: 'x', kind: 'click', description: 'original target', target }, snapshot, new AbortController().signal), /identity changed/);
  } finally { await driver?.close(); await env.close(); }
});
test('screenshot transmission requires operator opt-in', async () => {
  const env = await setup(done());
  try {
    const opened = await env.runner.open(env.fixture.url);
    await assert.rejects(env.runner.inspect(opened.sessionId, true), /captureArtifacts/);
  } finally { await env.close(); }
});
test('low confidence yields without executing a browser mutation', async () => {
  const env = await setup({ decide: async (_s, c) => ({ actionId: c[0]!.id, probability: 0.1, model: 'test', inputTokens: 0 }) });
  try {
    const opened = await env.runner.open(env.fixture.url);
    const result = await env.runner.explore(opened.sessionId, { objective: 'Ambiguous action' });
    assert.equal(result.status, 'blocked'); assert.equal(result.actionsExecuted, 0);
  } finally { await env.close(); }
});
test('mission deadline stops an unresponsive decider and keeps cached evidence readable', async () => {
  const env = await setup({ decide: async () => new Promise(() => {}) });
  try {
    const opened = await env.runner.open(env.fixture.url);
    const result = await env.runner.explore(opened.sessionId, { objective: 'Bounded wait', maxDurationMs: 1000 });
    assert.equal(result.status, 'budget_exhausted');
    assert.match((await env.runner.inspect(opened.sessionId, false)).summary, /cached/);
    const report = JSON.parse(readFileSync(join(result.artifactsDir, 'report.json'), 'utf8'));
    assert.equal(report.status, 'budget_exhausted');
  } finally { await env.close(); }
});
// Attached mode drives an operator-owned Chrome over CDP. It needs a real Chromium with
// remote debugging on a dedicated profile, so it is skipped in DOM-only mode.
if (!domOnly) test('attached Chrome is driven but never closed by the tester', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'jev-attach-'));
  const endpoint = 'http://127.0.0.1:9455';
  // Stand up the operator-owned Chrome exactly as the operator would: dedicated profile,
  // remote debugging on, plus a pre-existing tab and a pre-existing logged-in-looking cookie.
  const owned = await chromium.launchPersistentContext(profile, {
    headless: true, args: [`--remote-debugging-port=9455`],
  });
  try {
    await owned.addCookies([{ name: 'operator_session', value: 'operator-value', domain: '127.0.0.1', path: '/' }]);
    const operatorPage = await owned.newPage();
    const fixture = await startFixture();
    try {
      await operatorPage.goto(fixture.url, { waitUntil: 'domcontentloaded' });
      const root = mkdtempSync(join(tmpdir(), 'jev-attached-run-'));
      try {
        const base = parseConfig({ allowedOrigins: [fixture.url], headless: true, settleMs: 150, cdpEndpoint: endpoint });
        const runner = new Runner(root, base, done());
        const opened = await runner.open(fixture.url, new AbortController().signal, true);
        assert.ok(opened.events.some(e => e.kind === 'attached_browser'), 'attach must be recorded as evidence');
        // The tester must reach the page through its own context.
        assert.ok(opened.snapshot!.targets.some(t => t.label === 'Title'));
        const result = await runner.explore(opened.sessionId, { objective: 'Observe attached page' });
        assert.equal(result.status, 'stopped');
        // While the session is live, the page the tester drives must not be the operator's
        // tab and must not carry the operator's profile cookie. Assert the property, not a
        // context count: Playwright's newContext() on a persistent-context Chrome
        // re-enumerates contexts, so the operator's context is not reliably listed.
        const live = await chromium.connectOverCDP(endpoint);
        try {
          const allPages = live.contexts().flatMap(c => c.pages());
          // Object identity does not survive a second CDP connection, so identify pages by
          // the fact that the operator tab is the only one that can see its own cookie.
          // about:blank pages cannot be queried for cookies, so restrict to the test origin.
          const onOrigin = allPages.filter(p => p.url() === `${fixture.url}/`);
          const seen = await Promise.all(onOrigin.map(async p => ({ page: p, cookie: await p.evaluate(() => document.cookie) })));
          assert.equal(seen.length, 2, 'exactly the operator tab and the tester page must be open on the test origin');
          const withOperatorCookie = seen.filter(s => s.cookie.includes('operator_session'));
          assert.equal(withOperatorCookie.length, 1, 'only the operator tab may see the operator cookie');
          const tester = seen.filter(s => s !== withOperatorCookie[0]);
          assert.equal(tester.length, 1, 'tester must drive exactly one page');
          assert.equal(tester[0]!.cookie, '', 'tester page must not see the operator session cookie');
        } finally { await live.close(); }
        await runner.close(opened.sessionId);
        // The operator's Chrome and their pre-existing tab must survive the whole run.
        const alive = await fetch(`${endpoint}/json/version`).then(r => r.ok).catch(() => false);
        assert.equal(alive, true, 'attached Chrome must stay alive after qa_close');
        assert.equal(operatorPage.url(), `${fixture.url}/`, 'operator tab must not be navigated away');
        assert.equal(await operatorPage.title(), 'Jev QA fault fixture', 'operator tab must still show the same page');
        // owned.pages() counts every page in every context, so the surviving operator tab is
        // identified by URL rather than by a count that would also include tester pages.
        assert.ok(owned.pages().some(p => p === operatorPage), 'operator tab must survive');
        // The tester's context must be separate from the operator's, and must be gone after
        // qa_close, leaving only the operator's context with their cookie intact.
        const probe = await chromium.connectOverCDP(endpoint);
        try {
          // Object identity does not survive a second CDP connection; assert properties.
          const onOrigin = probe.contexts().flatMap(c => c.pages()).filter(p => p.url() === `${fixture.url}/`);
          assert.equal(onOrigin.length, 1, 'only the operator tab may remain on the test origin');
          const cookies = (await Promise.all(probe.contexts().map(c => c.cookies()))).flat();
          assert.equal(cookies.filter(c => c.name === 'operator_session').length, 1, 'operator profile cookie must be untouched');
        } finally { await probe.close(); }
      } finally { rmSync(root, { recursive: true, force: true }); }
    } finally { await fixture.close(); }
  } finally { await owned.close().catch(() => {}); rmSync(profile, { recursive: true, force: true }); }
});
if (!domOnly) test('cancelling an attached session detaches without closing the operator Chrome', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'jev-attach-cancel-'));
  const endpoint = 'http://127.0.0.1:9456';
  const owned = await chromium.launchPersistentContext(profile, {
    headless: true, args: [`--remote-debugging-port=9456`],
  });
  try {
    const fixture = await startFixture();
    try {
      const root = mkdtempSync(join(tmpdir(), 'jev-attached-cancel-'));
      try {
        const base = parseConfig({ allowedOrigins: [fixture.url], headless: true, settleMs: 150, cdpEndpoint: endpoint });
        // A decider that never resolves: cancellation must be what ends the mission.
        const runner = new Runner(root, base, { decide: () => new Promise(() => {}) });
        const opened = await runner.open(fixture.url, new AbortController().signal, true);
        const controller = new AbortController();
        const mission = runner.explore(opened.sessionId, { objective: 'Cancel me', maxDurationMs: 30000 }, controller.signal);
        await pause(400, controller.signal);
        controller.abort(new Error('Operator cancelled'));
        const result = await mission;
        assert.equal(result.status, 'cancelled');
        const alive = await fetch(`${endpoint}/json/version`).then(r => r.ok).catch(() => false);
        assert.equal(alive, true, 'attached Chrome must survive cancellation');
        const probe = await chromium.connectOverCDP(endpoint);
        try {
          const onOrigin = probe.contexts().flatMap(c => c.pages()).filter(p => p.url() === `${fixture.url}/`);
          assert.equal(onOrigin.length, 0, 'tester page must be torn down on cancellation');
        } finally { await probe.close(); }
      } finally { rmSync(root, { recursive: true, force: true }); }
    } finally { await fixture.close(); }
  } finally { await owned.close().catch(() => {}); rmSync(profile, { recursive: true, force: true }); }
});
