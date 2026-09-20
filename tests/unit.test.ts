import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, parseMission } from '../src/config.js';
import { assertUrl, permittedRequest, safeUrl, makeRedactor, redactDeep, buildCandidates } from '../src/policy.js';
import { parseDecision, JevDecider, type SystemOneClient } from '../src/jev.js';
import { Recorder } from '../src/recorder.js';
import { abortable } from '../src/validation.js';
import type { Snapshot, Candidate } from '../src/types.js';

const config = parseConfig({ allowedOrigins: ['http://127.0.0.1:4173'] });
const snapshot: Snapshot = { id: 's', url: 'http://127.0.0.1:4173/', title: 'Fixture', text: 'Fixture', truncated: false, limitations: [],
  targets: [
    { id: 't', tag: 'input', role: '', type: 'text', label: 'Title', locator: '#title', identity: 'title' },
    { id: 's', tag: 'button', role: '', type: 'submit', label: 'Save', locator: '#save', identity: 'save' },
    { id: 'd', tag: 'button', role: '', type: '', label: 'Delete records', locator: '#delete', identity: 'delete' },
  ] };
const choices: Candidate[] = [{ id: 'a0', kind: 'wait', description: 'Wait' }, { id: 'done', kind: 'done', description: 'Yield' }];
const response = () => ({ model: 'jev-1.13.0', usage: { input_tokens: 12, output_tokens: 0 },
  answers: { action: { type: 'choice', choice: 'a0', confidence: 0.8, probabilities: { a0: 0.9, done: 0.1 } } } });

test('origins are mandatory, exact and HTTP(S)', () => {
  assert.throws(() => parseConfig({}), /allowedOrigins/);
  assert.throws(() => parseConfig({ allowedOrigins: ['http://localhost:3000/path'] }), /origins/);
  assert.throws(() => parseConfig({ allowedOrigins: ['file:///tmp'] }));
  assert.throws(() => assertUrl('http://127.0.0.1:4174/', config));
  assert.doesNotThrow(() => assertUrl('http://127.0.0.1:4173/path', config));
});
test('resource origins cannot become navigation origins', () => {
  const c = { ...config, resourceOrigins: ['https://cdn.example.test'] };
  assert.equal(permittedRequest('https://cdn.example.test/a.js', c, false), true);
  assert.equal(permittedRequest('https://cdn.example.test/', c, true), false);
  assert.equal(permittedRequest('https://cdn.example.test.evil.invalid/', c, false), false);
});
test('credential-bearing navigation URLs are rejected', () => {
  assert.throws(() => assertUrl('http://u:p@127.0.0.1:4173/', config));
  assert.throws(() => assertUrl('http://127.0.0.1:4173/?token=private', config));
});
test('model arguments cannot raise operator budgets', () => {
  assert.throws(() => parseMission({ objective: 'Explore', maxActions: 1000 }, config));
  assert.throws(() => parseMission({ objective: 'Explore', burstClicks: 11 }, config));
  const m = parseMission({ objective: 'Explore', allowedOrigins: ['https://evil.invalid'], allowRiskyActions: true }, config);
  assert.equal('allowedOrigins' in m, false);
  assert.equal('allowRiskyActions' in m, false);
});
test('negative inputs retain empty strings and whitespace', () => {
  const m = parseMission({ objective: 'Validation', inputs: [{ field: 'Title', value: '' }, { field: 'Title', value: '   ' }] }, config);
  const c = buildCandidates(snapshot, m, config);
  assert.deepEqual(c.filter(a => a.kind === 'fill').map(a => a.value), ['', '   ']);
  assert.equal(c.some(a => a.target?.label === 'Delete records'), false);
  assert.equal(c.some(a => a.kind === 'reload'), false);
});
test('candidate count stays below Jev Choice limit', () => {
  const s = { ...snapshot, targets: Array.from({ length: 60 }, (_, i) => ({ ...snapshot.targets[0]!, id: `e${i}` })) };
  const m = parseMission({ objective: 'Explore', inputs: Array.from({ length: 8 }, (_, i) => ({ field: '*', value: `${i}` })) }, config);
  const c = buildCandidates(s, m, config);
  assert.ok(c.length <= 255); assert.equal(c.at(-1)?.id, 'blocked'); assert.equal(c.at(-2)?.id, 'done');
});
test('redaction does not corrupt JSON or leak configured secrets', () => {
  const redact = makeRedactor({ TYPESAFE_API_KEY: 'super-secret-value', QA_REDACT_ENV: 'TEST_PASSWORD', TEST_PASSWORD: 'very-private' });
  const value = redactDeep({ message: 'Bearer abc.def super-secret-value very-private', nested: ['normal'] }, redact);
  assert.equal(JSON.stringify(value).includes('super-secret-value'), false);
  assert.equal(JSON.stringify(value).includes('very-private'), false);
  assert.equal(safeUrl('https://x.test/?q=secret#hidden').includes('secret'), false);
});
test('valid Jev choice is validated without interpreting confidence as correctness', () => {
  assert.deepEqual(parseDecision(response(), choices), { actionId: 'a0', probability: 0.9, model: 'jev-1.13.0', inputTokens: 12 });
});
test('unknown actions, wrong types and malformed distributions are refused', () => {
  const unknown = response(); unknown.answers.action.choice = 'eval'; assert.throws(() => parseDecision(unknown, choices));
  const bad = response(); bad.answers.action.probabilities.a0 = 100; assert.throws(() => parseDecision(bad, choices));
  const sum = response(); sum.answers.action.probabilities.a0 = 0.2; assert.throws(() => parseDecision(sum, choices));
  const wrong = response(); wrong.answers.action.type = 'text'; assert.throws(() => parseDecision(wrong, choices));
  assert.throws(() => parseDecision({}, choices));
});
test('official SDK-shaped boundary receives model, state, candidates and abort signal', async () => {
  let captured: unknown; let capturedSignal: AbortSignal | undefined;
  const client: SystemOneClient = { systemOne: async (request, options) => { captured = request; capturedSignal = options.signal; return response(); } };
  const signal = new AbortController().signal;
  const result = await new JevDecider(config, client).decide(snapshot, choices, parseMission({ objective: 'Explore' }, config), [], signal);
  assert.equal(result.actionId, 'a0'); assert.equal(capturedSignal, signal);
  assert.match(JSON.stringify(captured), /jev-1.13.0/); assert.match(JSON.stringify(captured), /untrusted/);
});
test('action attempts are persisted before completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-recorder-'));
  try {
    const r = new Recorder(root, snapshot.url, s => s, 'test');
    r.start({ index: 0, startedAtMs: Date.now(), snapshotUrl: snapshot.url, action: choices[0]!, status: 'started' });
    assert.equal(JSON.parse(readFileSync(join(r.dir, 'actions.json'), 'utf8'))[0].status, 'started');
    r.actions[0]!.status = 'error'; r.complete();
    assert.equal(JSON.parse(readFileSync(join(r.dir, 'actions.json'), 'utf8')).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('abort interrupts a hanging asynchronous task', async () => {
  const controller = new AbortController();
  const promise = abortable(new Promise<never>(() => {}), controller.signal);
  controller.abort(new Error('stop'));
  await assert.rejects(promise, /stop/);
});
