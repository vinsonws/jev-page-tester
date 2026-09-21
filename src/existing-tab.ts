import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright';
import type { Config } from './types.js';
import { assertUrl } from './policy.js';
import { abortable } from './validation.js';

export const PLAYWRIGHT_MCP_VERSION = '0.0.82';
const require = createRequire(import.meta.url);
type McpModule = typeof import('@playwright/mcp');
export type ConnectionFactory = McpModule['createConnection'];
export interface ExistingTabLease {
  page: Page;
  /** Disconnect this client; NEVER close the borrowed page/context. */
  release(): Promise<void>;
}
interface HookState { pages: Page[]; cancelled: boolean; }
/** A pending extension permission prompt has no public AbortSignal API upstream.
 * The production worker restarts after this error to destroy pending relay sockets. */
export class ExtensionConnectCancelled extends Error { readonly restartWorker = true; }

/** Public createConnection + public initPage hook; no Playwright private imports,
 * no copied extension, no model-authored JavaScript and no cookie export. */
export async function connectExistingTab(
  expectedUrl: string, config: Config, signal: AbortSignal,
  factory?: ConnectionFactory,
): Promise<ExistingTabLease> {
  if (!config.allowExistingTab) throw new Error('existing-tab requires operator allowExistingTab=true');
  assertUrl(expectedUrl, config);
  signal.throwIfAborted();
  // Do not let unrelated MCP settings skip manual approval or change modes.
  for (const name of ['PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'PLAYWRIGHT_MCP_CDP_ENDPOINT',
    'PLAYWRIGHT_MCP_ENDPOINT', 'PLAYWRIGHT_MCP_ISOLATED', 'PLAYWRIGHT_MCP_CONFIG',
    'PLAYWRIGHT_MCP_INIT_PAGE', 'PLAYWRIGHT_MCP_INIT_SCRIPT', 'PLAYWRIGHT_MCP_STORAGE_STATE',
    'PLAYWRIGHT_MCP_USER_DATA_DIR', 'PLAYWRIGHT_MCP_SHARED_BROWSER_CONTEXT']) {
    if (process.env[name]) throw new Error(`Unset ${name} for manually authorized existing-tab mode`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'jev-extension-'));
  const hookPath = join(dir, 'page-hook.cjs');
  // This runs on Node's Playwright Page object, NOT in the page JavaScript realm.
  writeFileSync(hookPath, `exports.pages = []; exports.cancelled = false;\nexports.default = async ({ page }) => {\n  if (exports.cancelled) { await page.context().browser()?.close().catch(() => {}); return; }\n  if (!exports.pages.includes(page)) exports.pages.push(page);\n};\n`, { mode: 0o600 });
  const hook = require(hookPath) as HookState;
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(new Error('Extension authorization timed out')), config.extensionConnectTimeoutMs);
  const combined = AbortSignal.any([signal, timer.signal]);
  let client: import('@modelcontextprotocol/sdk/client/index.js').Client | undefined;
  let server: Awaited<ReturnType<ConnectionFactory>> | undefined;
  let closing: Promise<void> | undefined;
  const release = (): Promise<void> => closing ??= (async () => {
    hook.cancelled = true;
    // A CDP Browser.close releases its transport, not the external Chrome process.
    // Never invoke page.close(), context.close(), or browser_close here.
    const browsers = new Set<Browser>();
    for (const p of hook.pages) { const b = p.context().browser(); if (b) browsers.add(b); }
    await Promise.allSettled([...browsers].map(b => b.close()));
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    hook.pages.length = 0;
    delete require.cache[hookPath];
    rmSync(dir, { recursive: true, force: true });
  })();
  try {
    const [{ Client }, { InMemoryTransport }, mcp] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/inMemory.js'),
      factory ? Promise.resolve({ createConnection: factory }) : import('@playwright/mcp'),
    ]);
    combined.throwIfAborted();
    server = await mcp.createConnection({
      extension: true, browser: { isolated: false, initPage: [hookPath], initScript: [], contextOptions: {} },
      capabilities: ['core-tabs'], webmcp: false, snapshot: { mode: 'none' },
      imageResponses: 'omit', saveSession: false, outputDir: dir,
      network: { allowedOrigins: [], blockedOrigins: [] }, codegen: 'none',
      timeouts: { action: config.actionTimeoutMs, navigation: config.actionTimeoutMs, idle: 0 },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'Jev Page Tester', version: '0.2.0' }, { capabilities: { roots: {} } });
    const { ListRootsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(dir).href, name: 'Private connection workspace' }] }));
    await abortable(client.connect(clientTransport), combined);
    const response = await abortable(client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }, undefined,
      { signal: combined, timeout: config.extensionConnectTimeoutMs }), combined);
    if (response.isError) {
      const blocks: unknown[] = Array.isArray(response.content) ? response.content : [];
      const message = blocks.flatMap((block: unknown) => {
        if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'text' ||
          !('text' in block) || typeof block.text !== 'string') return [];
        return [block.text];
      }).join('\n');
      throw new Error(`Playwright extension connection failed: ${message.slice(0, 1500)}`);
    }
    combined.throwIfAborted();
    const pages = hook.pages.filter(p => !p.isClosed());
    if (pages.length !== 1) throw new Error('Authorize exactly ONE existing tab in the Playwright extension; no tab was selected or several tabs were shared');
    const page = pages[0]!;
    assertUrl(page.url(), config);
    if (new URL(page.url()).origin !== new URL(expectedUrl).origin) throw new Error('The authorized tab does not match the requested origin; no navigation was performed');
    return { page, release };
  } catch (error) {
    await release();
    if (combined.aborted) throw new ExtensionConnectCancelled('Extension connection cancelled or timed out; restart the QA worker to release the pending browser approval');
    throw error;
  } finally { clearTimeout(timeout); }
}
