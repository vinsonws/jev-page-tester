import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle } from 'playwright';
import type { Candidate, Config, Snapshot, Target, Check } from './types.js';
import { Recorder } from './recorder.js';
import { assertUrl, permittedRequest, safeUrl, PRIVATE, RISKY } from './policy.js';
import { pause } from './validation.js';

type Handle = ElementHandle<Node>;
/** This function runs in the page realm. Never reference module globals inside it. */
async function describe(handle: Handle, blocked: string[]): Promise<Omit<Target, 'id'> | null> {
  return handle.evaluate((node, selectors) => {
    const el = node as HTMLElement;
    if (!el.isConnected || el.getRootNode() !== document) return null;
    if (selectors.some(s => el.closest(s)) || el.closest('[data-qa-private],[hidden],[aria-hidden="true"]')) return null;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') return null;
    if (el.matches(':disabled,[aria-disabled="true"]')) return null;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || '';
    const labels = 'labels' in el ? (el as HTMLInputElement).labels : null;
    const label = (el.getAttribute('aria-label') || (labels ? [...labels].map(l => l.textContent).join(' ') : '') ||
      el.getAttribute('placeholder') || (['submit', 'button', 'reset'].includes(type) ? (el as HTMLInputElement).value : '') || el.innerText || el.getAttribute('title') || el.getAttribute('name') || el.id || tag).trim().slice(0, 180);
    const sensitive = `${type} ${label} ${el.id} ${el.getAttribute('name')} ${el.getAttribute('autocomplete')}`;
    if (/password|passwd|secret|token|credential|api.?key|密码|密钥|令牌/i.test(sensitive) || ['hidden', 'file'].includes(type)) return null;
    const unique = (s: string) => document.querySelectorAll(s).length === 1;
    let locator = '';
    const testId = el.getAttribute('data-testid');
    if (testId && unique(`[data-testid="${CSS.escape(testId)}"]`)) locator = `[data-testid="${CSS.escape(testId)}"]`;
    else if (el.id && unique(`#${CSS.escape(el.id)}`)) locator = `#${CSS.escape(el.id)}`;
    else {
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current !== document.documentElement) {
        const parent: Element | null = current.parentElement;
        const siblings: Element[] = parent ? [...parent.children].filter(x => x.tagName === current!.tagName) : [current];
        parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
        current = parent;
      }
      locator = `html > ${parts.join(' > ')}`;
    }
    const role = el.getAttribute('role') || (el.isContentEditable ? 'textbox' : '');
    return { tag, role, label, type, locator,
      identity: JSON.stringify([tag, type, role, label, el.id, testId, el.getAttribute('name')]),
      value: ['input', 'textarea'].includes(tag) ? (el as HTMLInputElement).value.slice(0, 200) : undefined,
      options: tag === 'select' ? [...(el as HTMLSelectElement).options].filter(o => !o.disabled).slice(0, 10).map(o => ({ label: o.text.slice(0, 100), value: o.value })) : undefined,
    };
  }, blocked);
}

export class BrowserDriver {
  private handles = new Map<string, Handle>();
  private traced = false;
  private closed = false;
  private closing?: Promise<void>;
  private snapshotId = '';
  private fixtureUrl?: string;
  private pageUrl(): string { return this.fixtureUrl ?? this.page.url(); }
  private constructor(readonly browser: Browser, readonly context: BrowserContext,
    readonly page: Page, readonly config: Config, readonly recorder: Recorder) {}

  static open(url: string, c: Config, recorder: Recorder): Promise<BrowserDriver> {
    return this.create(url, c, recorder);
  }
  /** Offline test seam only. Never called by the production worker. No URL navigation occurs. */
  static openDomFixture(url: string, c: Config, recorder: Recorder, html: string): Promise<BrowserDriver> {
    return this.create(url, c, recorder, html);
  }
  private static async create(url: string, c: Config, recorder: Recorder, fixtureHtml?: string): Promise<BrowserDriver> {
    assertUrl(url, c);
    const browser = await chromium.launch({ timeout: 10000, headless: c.headless, executablePath: c.executablePath,
      ...(c.browserProxy ? { proxy: { server: c.browserProxy } } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 },
        serviceWorkers: 'block', acceptDownloads: false,
        ...(process.env.QA_STORAGE_STATE ? { storageState: process.env.QA_STORAGE_STATE } : {}) });
      const denied = new WeakSet<object>();
      await context.route('**/*', async route => {
        const request = route.request();
        if (permittedRequest(request.url(), c, request.isNavigationRequest())) {
          await route.continue();
        } else {
          denied.add(request);
          recorder.event('origin_block', 'policy', `Blocked ${safeUrl(request.url())}`);
          await route.abort('blockedbyclient');
        }
      });
      await context.routeWebSocket('**/*', socket => {
        const url = socket.url().replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
        if (permittedRequest(url, c, false)) socket.connectToServer();
        else { recorder.event('websocket_block', 'policy', safeUrl(url)); socket.close(); }
      });
      const page = await context.newPage();
      const driver = new BrowserDriver(browser, context, page, c, recorder);
      page.setDefaultTimeout(c.actionTimeoutMs);
      page.setDefaultNavigationTimeout(c.actionTimeoutMs);
      page.on('pageerror', e => recorder.event('pageerror', 'runtime', e.message));
      page.on('crash', () => recorder.event('crash', 'runtime', 'Renderer crashed'));
      page.on('console', msg => { if (msg.type() === 'error') recorder.event('console_error', 'signal', msg.text()); });
      page.on('response', response => {
        if (response.status() >= 400) recorder.event(response.status() >= 500 ? 'http_5xx' : 'http_4xx', 'signal', `${response.status()} ${safeUrl(response.url())}`);
      });
      page.on('requestfailed', request => {
        if (!denied.has(request)) recorder.event('request_failed', 'signal', `${safeUrl(request.url())}: ${request.failure()?.errorText || 'unknown'}`);
      });
      page.on('dialog', dialog => {
        recorder.event('dialog', 'observation', `Automatically dismissed ${dialog.type()}: ${dialog.message()}`);
        void dialog.dismiss().catch(() => {});
      });
      page.on('download', download => { recorder.event('download_block', 'policy', 'Downloads are not supported'); void download.cancel().catch(() => {}); });
      context.on('page', popup => { recorder.event('popup_block', 'policy', 'Extra tabs are outside this MVP'); void popup.close().catch(() => {}); });
      if (c.captureArtifacts) { await context.tracing.start({ screenshots: true, snapshots: true }); driver.traced = true; }
      if (fixtureHtml !== undefined) {
        driver.fixtureUrl = url;
        await page.setContent(fixtureHtml, { waitUntil: 'domcontentloaded' });
        recorder.event('dom_fixture_mode', 'observation', 'Offline DOM fixture: navigation/network behavior is NOT verified.');
      } else await page.goto(url, { waitUntil: 'domcontentloaded' });
      return driver;
    } catch (e) { await browser.close(); throw e; }
  }

  async observe(): Promise<Snapshot> {
    assertUrl(this.pageUrl(), this.config);
    await this.disposeHandles();
    const handles = await this.page.locator('button,a[href],input,textarea,select,[role="button"],[role="textbox"],[contenteditable="true"],[tabindex="0"]').elementHandles();
    const targets: Target[] = [];
    let processed = 0; let truncated = false;
    for (const handle of handles) {
      if (targets.length >= 60 || processed++ >= 300) { truncated = true; await handle.dispose(); continue; }
      const data = await describe(handle, this.config.blockedSelectors);
      if (!data) { await handle.dispose(); continue; }
      const id = `e${targets.length}`;
      // Keep exact identities privately for stale checks; redact all model-facing strings below.
      targets.push({ ...data, id }); this.handles.set(id, handle);
    }
    const content = await this.page.evaluate((blocked) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const parts: string[] = []; let length = 0; let scanned = 0;
      while (walker.nextNode() && length < 5000 && scanned++ < 5000) {
        const parent = walker.currentNode.parentElement;
        if (!parent || parent.closest('script,style,noscript,[data-qa-private],[hidden],[aria-hidden="true"]') || blocked.some(s => parent.closest(s))) continue;
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || !parent.getClientRects().length) continue;
        const value = walker.currentNode.textContent?.trim();
        if (value) { parts.push(value); length += value.length; }
      }
      return parts.join('\n').slice(0, 5000);
    }, this.config.blockedSelectors);
    this.snapshotId = randomUUID();
    const snapshot: Snapshot = { id: this.snapshotId, url: safeUrl(this.pageUrl()),
      title: this.recorder.redact(await this.page.title()), text: this.recorder.redact(content),
      targets, truncated,
      limitations: ['Main-document DOM only; no iframe, canvas or closed-shadow inspection.',
        ...(this.page.frames().length > 1 ? ['This page contains frames; their contents were not inspected.'] : [])] };
    this.recorder.write('snapshot.json', snapshot);
    return snapshot;
  }

  async execute(a: Candidate, snapshot: Snapshot | undefined, signal: AbortSignal, replay = false, times: number[] = []): Promise<number[]> {
    signal.throwIfAborted();
    assertUrl(this.pageUrl(), this.config);
    if (a.target && (PRIVATE.test(`${a.target.type} ${a.target.label}`) || (!this.config.allowRiskyActions && RISKY.test(a.target.label)))) throw new Error('Action blocked by operator policy');
    let handle: Handle | undefined;
    let owned = false;
    if (a.target) {
      if (replay) {
        const locator = this.page.locator(a.target.locator);
        if (await locator.count() !== 1) throw new Error('Replay target is missing or ambiguous');
        handle = await locator.elementHandle() ?? undefined; owned = true;
      } else {
        if (snapshot?.id !== this.snapshotId) throw new Error('Stale snapshot');
        handle = this.handles.get(a.target.id);
      }
      if (!handle) throw new Error('Target is detached or missing');
      const current = await describe(handle, this.config.blockedSelectors);
      if (!current || current.identity !== a.target.identity) throw new Error('Target identity changed; refusing to retarget silently');
      if (current.tag === 'a') {
        const href = await handle.evaluate(el => (el as HTMLAnchorElement).href);
        assertUrl(href, this.config);
      }
    }
    try {
      switch (a.kind) {
        case 'click': await handle!.click(); times.push(Date.now()); break;
        case 'fill': await handle!.fill(a.value ?? ''); break;
        case 'select': await handle!.selectOption(a.value ?? ''); break;
        case 'burst_click':
          if (!Number.isInteger(a.count) || a.count! < 1 || a.count! > this.config.maxBurstClicks) throw new Error('Burst exceeds operator limit');
          for (let i = 0; i < a.count!; i++) {
            signal.throwIfAborted();
            if (!(await handle!.isEnabled()) || !(await handle!.isVisible())) break;
            times.push(Date.now()); await handle!.click();
          }
          break;
        case 'press': if (a.value !== 'Escape') throw new Error('Unsupported key'); await this.page.keyboard.press('Escape'); break;
        case 'scroll': await this.page.mouse.wheel(0, a.value === 'up' ? -650 : 650); break;
        case 'reload': await this.page.reload({ waitUntil: 'domcontentloaded' }); break;
        case 'back': await this.page.goBack({ waitUntil: 'domcontentloaded' }); break;
        case 'wait': await pause(Math.max(300, this.config.settleMs), signal); break;
        default: throw new Error('Unknown executable action');
      }
      signal.throwIfAborted();
      return times;
    } finally { if (owned) await handle?.dispose(); }
  }

  async check(check: Check): Promise<boolean> {
    const locator = this.page.locator(check.selector);
    if (check.kind === 'count') return await locator.count() === check.expected;
    if (await locator.count() !== 1) return false;
    if (check.kind === 'text') return (await locator.innerText()).includes(String(check.expected));
    const handle = await locator.elementHandle();
    if (!handle) return false;
    try {
      if (!(await describe(handle, this.config.blockedSelectors))) throw new Error('Private or unsupported value-check target');
      return await locator.inputValue() === check.expected;
    } finally { await handle.dispose(); }
  }
  async screenshot(): Promise<string | undefined> {
    if (!this.config.captureArtifacts || this.closed) return;
    const path = join(this.recorder.dir, 'latest.png');
    await this.page.screenshot({ path, timeout: this.config.actionTimeoutMs });
    return path;
  }
  private async disposeHandles(): Promise<void> {
    await Promise.all([...this.handles.values()].map(h => h.dispose().catch(() => {})));
    this.handles.clear();
  }
  close(): Promise<void> {
    this.closing ??= this.finishClose();
    return this.closing;
  }
  private async finishClose(): Promise<void> {
    this.closed = true;
    await this.disposeHandles();
    try { if (this.traced) await this.context.tracing.stop({ path: join(this.recorder.dir, 'trace.zip') }); }
    finally { await this.browser.close(); }
  }
}
