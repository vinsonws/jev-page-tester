import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, fixtureHtml } from '../examples/fixture.js';
import { parseConfig } from '../src/config.js';
import { Runner } from '../src/runner.js';
import { BrowserDriver } from '../src/browser.js';
import { Recorder } from '../src/recorder.js';
import { ScriptedDecider } from '../src/demo-decider.js';
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
