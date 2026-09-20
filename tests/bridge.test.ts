import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { WorkerBridge } from '../src/bridge.js';

const root = process.cwd();
const create = () => new WorkerBridge(root, resolve(root, 'tests/echo-worker.mjs'));
test('stdio RPC returns results and progress', async () => {
  const bridge = create(); const updates: string[] = [];
  try { assert.deepEqual(await bridge.call('echo', { ok: true }, undefined, m => updates.push(m)), { ok: true }); assert.deepEqual(updates, ['working']); }
  finally { await bridge.stop(); }
});
test('cancellation reaches the child instead of leaving work running', async () => {
  const bridge = create(); const controller = new AbortController();
  try {
    const result = await bridge.call('wait', {}, controller.signal, () => controller.abort());
    assert.deepEqual(result, { status: 'cancelled' });
  } finally { await bridge.stop(); }
});
test('malformed worker output rejects requests', async () => {
  const bridge = create();
  try { await assert.rejects(bridge.call('malformed', {}), /protocol/); }
  finally { await bridge.stop(); }
});
test('OMP extension registers the five intended tools and cleanup hooks', async () => {
  const modulePath: string = resolve(root, '.omp/extensions/qa.js');
  const extension = await import(modulePath);
  const schema = { optional() { return this; } };
  const z = Object.fromEntries(['string', 'number', 'boolean', 'object', 'array', 'union', 'enum'].map(k => [k, () => schema]));
  const names: string[] = []; const events: string[] = []; const commands: string[] = [];
  extension.default({ zod: z, registerTool: (tool: { name: string }) => names.push(tool.name),
    on: (event: string) => events.push(event), registerCommand: (command: string) => commands.push(command) });
  assert.deepEqual(names, ['qa_open', 'qa_explore', 'qa_inspect', 'qa_replay', 'qa_close']);
  assert.ok(events.includes('session_shutdown')); assert.deepEqual(commands, ['qa-stop']);
});
