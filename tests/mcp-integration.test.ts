import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createConnection } from '@playwright/mcp';
import { connectExistingTab, ExtensionConnectCancelled, type ConnectionFactory } from '../src/existing-tab.js';
import { parseConfig } from '../src/config.js';
import { startFixture } from '../examples/fixture.js';
import { BrowserDriver } from '../src/browser.js';
import { Recorder } from '../src/recorder.js';

const require = createRequire(import.meta.url);
// Public package resolution: use the Playwright build pinned by the MCP package.
const mcpRequire = createRequire(require.resolve('@playwright/mcp'));
const mcpPlaywright = mcpRequire('playwright') as typeof import('playwright');
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()));
  return port;
}
/** Real installed MCP + SDK + initPage + real CDP Page. The public contextGetter
 * replaces ONLY the interactive extension chooser in CI. This does NOT claim
 * to exercise the Chrome extension UI/manual permission dialog. */
test('official pinned MCP captures an existing CDP page without navigation or login loss', { timeout: 30000 }, async () => {
  const fixture = await startFixture(); const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'jev-mcp-profile-'));
  const root = mkdtempSync(join(tmpdir(), 'jev-mcp-run-'));
  const owned = await mcpPlaywright.chromium.launchPersistentContext(profile, {
    headless: true, executablePath: chromium.executablePath(), args: [`--remote-debugging-port=${port}`],
  });
  const remote = await mcpPlaywright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let lease: Awaited<ReturnType<typeof connectExistingTab>> | undefined;
  let driver: BrowserDriver | undefined;
  try {
    const original = owned.pages()[0]!; await original.goto(fixture.url);
    await owned.addCookies([{ name: 'synthetic_session', value: 'logged-in', url: fixture.url, httpOnly: true }]);
    await original.evaluate(() => { localStorage.setItem('draft-id', 'local-value'); });
    await original.locator('#title').fill('unfinished input');
    let navigations = 0; original.on('framenavigated', () => navigations++);
    let factoryCalls = 0;
    const factory: ConnectionFactory = async config => {
      factoryCalls++; assert.equal(config?.extension, true);
      assert.equal(config?.snapshot?.mode, 'none'); assert.equal(config?.webmcp, false);
      assert.deepEqual(config?.network?.allowedOrigins, []);
      // This context came from MCP's own runtime; the root Playwright type is
      // older and differs in optional methods, so cast only at this test seam.
      return createConnection(config, async () => remote.contexts()[0]! as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof createConnection>[1]>>>);
    };
    const config = parseConfig({ allowedOrigins: [fixture.url], allowExistingTab: true, extensionConnectTimeoutMs: 10000 });
    lease = await connectExistingTab(fixture.url, config, new AbortController().signal, factory);
    assert.equal(factoryCalls, 1); assert.equal(lease.page.url(), `${fixture.url}/`);
    assert.equal(await lease.page.locator('#title').inputValue(), 'unfinished input');
    const recorder = new Recorder(root, fixture.url, s => s, 'mcp-test-no-model');
    driver = await BrowserDriver.borrowPage(lease.page, config, recorder, lease.release);
    const snapshot = await driver.observe(); const target = snapshot.targets.find(t => t.label === 'Title')!;
    await driver.execute({ id: 'fill', kind: 'fill', description: 'scripted input', target, value: 'mcp input' }, snapshot, new AbortController().signal);
    assert.equal(await original.locator('#title').inputValue(), 'mcp input');
    assert.equal(navigations, 0); assert.equal(await original.evaluate(() => localStorage.getItem('draft-id')), 'local-value');
    await driver.close();
    assert.equal(remote.isConnected(), false, 'borrowed CDP transport must be released');
    assert.equal(original.isClosed(), false, 'operator page must survive');
    assert.ok((await owned.cookies()).some(c => c.name === 'synthetic_session'));
    await original.locator('#title').fill('operator resumed');
    console.log('REAL_PINNED_MCP: public factory + initPage + CDP capture/execution/release passed; extension approval UI substituted by contextGetter');
  } finally {
    await driver?.close().catch(() => {}); await lease?.release().catch(() => {});
    await remote.close().catch(() => {}); await owned.close().catch(() => {});
    await fixture.close(); rmSync(profile, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});
test('a cancelled pending MCP handshake is classified for worker retirement, not late browser actions', { timeout: 10000 }, async () => {
  let finish!: () => void; const stalled = new Promise<void>(r => { finish = r; });
  let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const config = parseConfig({ allowedOrigins: ['http://localhost:3000'], allowExistingTab: true, extensionConnectTimeoutMs: 3000 });
  const controller = new AbortController();
  const factory: ConnectionFactory = config => createConnection(config, async () => {
    entered(); await stalled; throw new Error('Synthetic chooser closed');
  });
  const pending = connectExistingTab('http://localhost:3000', config, controller.signal, factory);
  await ready; controller.abort();
  try { await assert.rejects(pending, ExtensionConnectCancelled); }
  finally { finish(); }
});
