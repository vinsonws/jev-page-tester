import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, parseBrowserMode, resolveBrowserMode } from '../src/config.js';
import { connectExistingTab } from '../src/existing-tab.js';
import { snapshotFingerprint } from '../src/runner.js';
import type { Snapshot } from '../src/types.js';

const config = () => parseConfig({ allowedOrigins: ['http://localhost:3000'] });
test('existing-tab is opt-in; legacy attach retains isolated semantics', () => {
  const c = config();
  assert.equal(c.browserMode, 'launch-isolated'); assert.equal(c.allowExistingTab, false);
  assert.equal(resolveBrowserMode(c, undefined, true), 'cdp-isolated');
  assert.equal(resolveBrowserMode(c, undefined, false), 'launch-isolated');
  assert.throws(() => resolveBrowserMode(c, 'existing-tab', true), /not both/);
  assert.throws(() => parseBrowserMode('current-active-tab'), /browser mode/);
  assert.throws(() => parseConfig({ allowedOrigins: c.allowedOrigins, browserMode: 'existing-tab' }), /allowExistingTab/);
  assert.throws(() => parseConfig({ allowedOrigins: c.allowedOrigins, extensionConnectTimeoutMs: 999999 }), /./);
});
test('unapproved configuration and autoapproval token never reach the extension factory', async () => {
  let calls = 0;
  const factory = async () => { calls++; throw new Error('must not run'); };
  await assert.rejects(connectExistingTab('http://localhost:3000', config(), new AbortController().signal, factory), /allowExistingTab/);
  const old = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = 'synthetic-token';
  try {
    await assert.rejects(connectExistingTab('http://localhost:3000', { ...config(), allowExistingTab: true }, new AbortController().signal, factory), /Unset PLAYWRIGHT_MCP_EXTENSION_TOKEN/);
  } finally {
    if (old === undefined) delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    else process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = old;
  }
  assert.equal(calls, 0);
});
test('invalid origins and pre-aborted handshakes cannot start a connection', async () => {
  const c = { ...config(), allowExistingTab: true };
  await assert.rejects(connectExistingTab('https://not-authorized.test', c, new AbortController().signal), /Navigation blocked/);
  const controller = new AbortController(); controller.abort(new Error('cancel-before-open'));
  await assert.rejects(connectExistingTab('http://localhost:3000', c, controller.signal), /cancel-before-open/);
});
test('replay fingerprint ignores observation IDs but detects unfinished form drift', () => {
  const s: Snapshot = { id: '1', url: 'http://localhost:3000/', title: 'test', text: 'form', truncated: false, limitations: [],
    targets: [{ id: 'e0', locator: '#title', tag: 'input', type: '', role: '', label: 'Title', identity: 'title-1', value: 'draft' }] };
  assert.equal(snapshotFingerprint(s), snapshotFingerprint({ ...s, id: '2' }));
  assert.notEqual(snapshotFingerprint(s), snapshotFingerprint({ ...s, targets: [{ ...s.targets[0]!, value: 'new draft' }] }));
});
