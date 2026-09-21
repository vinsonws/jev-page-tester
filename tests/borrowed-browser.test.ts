import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startFixture } from '../examples/fixture.js';
import { BrowserDriver } from '../src/browser.js';
import { Recorder } from '../src/recorder.js';
import { Runner } from '../src/runner.js';
import { parseConfig } from '../src/config.js';
import { ScriptedDecider } from '../src/demo-decider.js';
import type { Decider } from '../src/types.js';

const skip = process.env.QA_DOM_ONLY === '1' ? 'Requires actual HTTP navigation; not a DOM-only substitute' : false;
async function setup() {
  const fixture = await startFixture();
  const root = mkdtempSync(join(tmpdir(), 'jev-borrow-test-'));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BROWSER_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1017, height: 713 } });
  const page = await context.newPage(); await page.goto(fixture.url);
  await context.addCookies([{ name: 'session-canary', value: 'synthetic', url: fixture.url, httpOnly: true }]);
  await page.evaluate(() => { localStorage.setItem('test-login', 'synthetic'); });
  await page.locator('#title').fill('unfinished draft');
  const config = parseConfig({ allowedOrigins: [fixture.url], headless: true, allowExistingTab: true,
    browserMode: 'existing-tab', settleMs: 150 });
  let releases = 0;
  const openExisting = async (_url: string, c = config, recorder = new Recorder(root, fixture.url, s => s, 'test')) =>
    BrowserDriver.borrowPage(page, c, recorder, async () => { releases++; });
  return { fixture, root, browser, context, page, config, openExisting,
    releases: () => releases,
    close: async () => { await browser.close(); await fixture.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('borrowed tab retains login, storage, draft, viewport; switching active tab never retargets', { skip }, async () => {
  const env = await setup(); let driver: BrowserDriver | undefined;
  try {
    let navigations = 0; env.page.on('framenavigated', () => navigations++);
    driver = await env.openExisting(env.fixture.url);
    const other = await env.context.newPage(); await other.goto(env.fixture.url); await other.bringToFront();
    const snapshot = await driver.observe();
    assert.equal(snapshot.targets.find(t => t.label === 'Title')?.value, 'unfinished draft');
    assert.equal(JSON.stringify(snapshot).includes('session-canary'), false);
    const target = snapshot.targets.find(t => t.label === 'Title')!;
    await driver.execute({ id: 'fill', kind: 'fill', description: 'synthetic input', target, value: 'agent input' }, snapshot, new AbortController().signal);
    assert.equal(await env.page.locator('#title').inputValue(), 'agent input');
    assert.equal(await other.locator('#title').inputValue(), '');
    assert.equal(navigations, 0); assert.deepEqual(env.page.viewportSize(), { width: 1017, height: 713 });
    assert.equal(await env.page.evaluate(() => localStorage.getItem('test-login')), 'synthetic');
    await driver.close(); await driver.close();
    assert.equal(env.releases(), 1); assert.equal(env.page.isClosed(), false); assert.equal(other.isClosed(), false);
    assert.ok((await env.context.cookies()).some(c => c.name === 'session-canary'));
    const countAfterRelease = driver.recorder.events.length;
    await env.page.evaluate(() => console.error('after-release-probe'));
    await env.page.waitForTimeout(50);
    assert.equal(driver.recorder.events.length, countAfterRelease, 'monitor callbacks must be removed after release');
    await assert.rejects(driver.observe(), /released/);
  } finally { await driver?.close(); await env.close(); }
});
test('borrowed page routes do not block other tabs and are removed on release', { skip }, async () => {
  const env = await setup(); const outside = await startFixture(); let driver: BrowserDriver | undefined;
  try {
    driver = await env.openExisting(env.fixture.url);
    const other = await env.context.newPage(); await other.goto(outside.url);
    assert.equal(await other.title(), 'Jev QA fault fixture');
    await assert.rejects(env.page.goto(outside.url), /ERR_BLOCKED_BY_CLIENT|ERR_FAILED|interrupted/);
    await driver.close();
    await env.page.goto(outside.url); assert.equal(await env.page.title(), 'Jev QA fault fixture');
  } finally { await driver?.close(); await outside.close(); await env.close(); }
});
test('closed or unauthorized bound tab is refused; no automatic replacement', { skip }, async () => {
  const env = await setup(); let driver: BrowserDriver | undefined;
  try {
    driver = await env.openExisting(env.fixture.url);
    const replacement = await env.context.newPage(); await replacement.goto(env.fixture.url);
    await env.page.close();
    await assert.rejects(driver.observe(), /closed|available/);
    assert.equal(await replacement.locator('#title').inputValue(), '');
    await driver.close(); assert.equal(replacement.isClosed(), false);
  } finally { await driver?.close(); await env.close(); }
});
test('existing-tab cancellation releases only control and retains evidence', { skip }, async () => {
  const env = await setup(); let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const decider: Decider = { decide: async () => { entered(); return new Promise(() => {}); } };
  const runner = new Runner(env.root, env.config, decider, undefined, env.openExisting);
  try {
    const opened = await runner.open(env.fixture.url);
    await assert.rejects(runner.open(env.fixture.url), /Release/);
    const controller = new AbortController();
    const operation = runner.explore(opened.sessionId, { objective: 'wait for cancellation' }, controller.signal);
    await ready; controller.abort(); const result = await operation;
    assert.equal(result.status, 'cancelled'); assert.equal(env.releases(), 1);
    assert.equal(env.page.isClosed(), false); assert.equal(env.browser.isConnected(), true);
    assert.equal(await env.page.locator('#title').inputValue(), 'unfinished draft');
    assert.match((await runner.inspect(opened.sessionId, false)).summary, /cached/);
  } finally { await runner.closeAll(); await env.close(); }
});
test('existing-tab action budget releases control without closing the page', { skip }, async () => {
  const env = await setup();
  const runner = new Runner(env.root, env.config, new ScriptedDecider(c => c.find(a => a.kind === 'fill')), undefined, env.openExisting);
  try {
    const opened = await runner.open(env.fixture.url);
    const result = await runner.explore(opened.sessionId, { objective: 'one fill', maxActions: 1, inputs: [{ field: 'Title', value: 'limited' }] });
    assert.equal(result.status, 'budget_exhausted'); assert.equal(env.releases(), 1);
    assert.equal(env.page.isClosed(), false); assert.equal(await env.page.locator('#title').inputValue(), 'limited');
  } finally { await runner.closeAll(); await env.close(); }
});
test('borrowed replay preserves mode, requires same initial DOM and never calls the model', { skip }, async () => {
  const env = await setup();
  const decider = new ScriptedDecider((c, i) => i === 0 ? c.find(a => a.kind === 'fill') : c.find(a => a.kind === 'done'));
  const runner = new Runner(env.root, env.config, decider, undefined, env.openExisting);
  try {
    const opened = await runner.open(env.fixture.url);
    await runner.explore(opened.sessionId, { objective: 'fill once', inputs: [{ field: 'Title', value: 'changed' }] });
    await runner.close(opened.sessionId);
    const calls = decider.calls;
    const mismatch = await runner.replay(opened.sessionId, true);
    assert.equal(mismatch.status, 'blocked'); assert.equal(mismatch.actionsExecuted, 0);
    assert.match(mismatch.summary, /initial state mismatch/);
    assert.equal(mismatch.browserMode, 'existing-tab'); assert.equal(decider.calls, calls);
    await env.page.locator('#title').fill('unfinished draft');
    const replay = await runner.replay(opened.sessionId, true);
    assert.equal(replay.status, 'stopped'); assert.equal(replay.actionsExecuted, 1);
    assert.equal(await env.page.locator('#title').inputValue(), 'changed');
    assert.equal(decider.calls, calls); assert.equal(env.page.isClosed(), false);
    const metadata = JSON.parse(readFileSync(join(replay.artifactsDir, 'browser.json'), 'utf8'));
    assert.equal(metadata.mode, 'existing-tab');
  } finally { await runner.closeAll(); await env.close(); }
});
test('release still runs when artifact cleanup fails; no context-wide trace on borrowed pages', { skip }, async () => {
  const env = await setup(); let driver: BrowserDriver | undefined;
  try {
    const recorder = new Recorder(env.root, env.fixture.url, s => s, 'test');
    driver = await env.openExisting(env.fixture.url, { ...env.config, captureArtifacts: true }, recorder);
    assert.ok(recorder.events.some(e => e.kind === 'trace_disabled'));
    env.context.tracing.stop = async () => { throw new Error('trace write failed'); };
    Object.assign(driver, { traced: true });
    await assert.rejects(driver.close(), /trace write failed/);
    assert.equal(env.releases(), 1); assert.equal(env.page.isClosed(), false);
  } finally { await driver?.close().catch(() => {}); await env.close(); }
});
