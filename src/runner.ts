import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Candidate, Check, Config, Decider, Progress, RunResult, RunStatus, Snapshot, ActionRecord } from './types.js';
import { BrowserDriver } from './browser.js';
import { Recorder } from './recorder.js';
import { assertUrl, buildCandidates, makeRedactor, redactDeep } from './policy.js';
import { parseMission } from './config.js';
import { abortable, errorText, object, pause, text } from './validation.js';

interface Session {
  recorder: Recorder; driver: BrowserDriver; snapshot?: Snapshot;
  busy: boolean; closed: boolean; decisions: number; reportedThrough: number;
  history: string[]; checkpoints: { afterAction: number; checks: Check[] }[];
}
const anomalyKinds = new Set(['pageerror', 'crash', 'http_5xx', 'assertion_failed']);
export class Runner {
  private readonly sessions = new Map<string, Session>();
  private opening = 0;
  private readonly redact = makeRedactor();
  constructor(readonly root: string, readonly config: Config, private readonly decider: Decider,
    private readonly openBrowser = BrowserDriver.open.bind(BrowserDriver)) {}
  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Unknown session ID');
    if (session.closed) throw new Error('Session is closed; open a fresh session or replay its artifacts');
    if (session.busy) throw new Error('Session is busy; parallel operations on one page are refused');
    return session;
  }
  async open(url: string, signal = new AbortController().signal): Promise<RunResult> {
    assertUrl(url, this.config); signal.throwIfAborted();
    if ([...this.sessions.values()].filter(s => !s.closed).length + this.opening >= this.config.maxSessions) throw new Error('Close an existing session before opening another');
    this.opening++;
    const recorder = new Recorder(resolve(this.root), url, this.redact, this.config.model);
    let driver: BrowserDriver | undefined;
    try {
      driver = await this.openBrowser(url, this.config, recorder);
      signal.throwIfAborted();
      const session: Session = { recorder, driver, busy: false, closed: false, decisions: 0, reportedThrough: 0, history: [], checkpoints: [] };
      this.sessions.set(recorder.id, session);
      session.snapshot = await abortable(driver.observe(), signal);
      await driver.screenshot();
      return this.result(session, 'stopped', 0, 'Browser opened. Inspect the initial evidence before choosing a bounded mission.');
    } catch (e) {
      recorder.event('open_error', 'harness', errorText(e));
      this.sessions.delete(recorder.id); await driver?.close().catch(() => {}); throw e;
    } finally { this.opening--; }
  }
  private result(s: Session, status: RunStatus, count: number, summary: string, persist = true): RunResult {
    const snapshot = s.snapshot ? redactDeep(s.snapshot, this.redact) as Snapshot : undefined;
    const result: RunResult = { sessionId: s.recorder.id, status, actionsExecuted: count,
      totalActions: s.recorder.actions.length, summary: this.redact(summary), events: s.recorder.events.slice(-30),
      snapshot, artifactsDir: s.recorder.dir, verdict: 'not_evaluated' };
    if (persist) s.recorder.report(result); return result;
  }
  private hasAnomaly(s: Session, from = s.reportedThrough): boolean {
    return s.recorder.events.slice(from).some(e => anomalyKinds.has(e.kind));
  }
  private async checks(s: Session, checks: Check[], signal: AbortSignal): Promise<boolean> {
    let success = true;
    for (const check of checks) {
      let ok = false; const deadline = Date.now() + Math.min(1500, this.config.actionTimeoutMs);
      do {
        signal.throwIfAborted(); ok = await abortable(s.driver.check(check), signal);
        if (!ok) await pause(100, signal);
      } while (!ok && Date.now() < deadline);
      s.recorder.event(ok ? 'assertion_satisfied' : 'assertion_failed', ok ? 'observation' : 'signal',
        `${check.label} (supervisor-supplied expectation; not an inferred product requirement)`);
      success &&= ok;
    }
    return success;
  }
  private async perform(s: Session, a: Candidate, signal: AbortSignal, replay = false): Promise<void> {
    const record: ActionRecord = { index: s.recorder.actions.length, startedAtMs: Date.now(),
      snapshotUrl: s.snapshot?.url || '', action: a, status: 'started', clickTimesMs: [] };
    s.recorder.start(record);
    try {
      record.clickTimesMs = await abortable(s.driver.execute(a, s.snapshot, signal, replay, record.clickTimesMs), signal);
      record.status = 'ok';
    } catch (e) { record.status = 'error'; record.error = this.redact(errorText(e)); throw e; }
    finally { s.recorder.complete(); }
    s.history.push(a.description); s.history = s.history.slice(-8);
    await pause(this.config.settleMs, signal);
  }
  async explore(id: string, input: unknown, signal = new AbortController().signal, progress: Progress = () => {}): Promise<RunResult> {
    const mission = parseMission(input, this.config);
    for (const inputCase of mission.inputs) {
      if (this.redact(inputCase.value) !== inputCase.value) throw new Error('Input contains a configured secret; use synthetic test values');
    }
    const s = this.get(id); s.busy = true;
    const startCount = s.recorder.actions.length;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('Mission time budget exhausted')), mission.maxDurationMs);
    const combined = AbortSignal.any([signal, timeout.signal]);
    const cancelBrowser = () => { s.closed = true; void s.driver.close().catch(() => {}); };
    combined.addEventListener('abort', cancelBrowser, { once: true });
    let status: RunStatus = 'budget_exhausted'; let summary = 'Action budget exhausted; yield to supervisor.';
    let previous = ''; let repeated = 0;
    s.recorder.event('mission', 'observation', mission.objective);
    s.recorder.write(`mission-${s.recorder.events.length}.json`, mission);
    try {
      combined.throwIfAborted();
      for (let step = 0; step < mission.maxActions; step++) {
        if (mission.stopOnAnomaly && this.hasAnomaly(s)) { status = 'anomaly'; summary = 'Independent instrumentation detected an anomaly. Preserve and inspect evidence.'; break; }
        if (s.recorder.actions.length >= this.config.maxSessionActions || s.decisions >= this.config.maxSessionActions * 2 || s.recorder.events.length >= 1500) {
          summary = 'Session action/model/event budget exhausted; open a new session after review.'; break;
        }
        s.snapshot = await abortable(s.driver.observe(), combined);
        const candidates = buildCandidates(s.snapshot, mission, this.config);
        progress(`Decision ${step + 1}/${mission.maxActions}; ${s.snapshot.targets.length} visible controls`);
        s.decisions++;
        const modelSignal = AbortSignal.any([combined, AbortSignal.timeout(this.config.jevTimeoutMs * 2 + 1000)]);
        let decision;
        try { decision = await abortable(this.decider.decide(s.snapshot, candidates, mission, s.history, modelSignal), modelSignal); }
        catch (e) {
          if (combined.aborted) throw e;
          s.recorder.event('model_error', 'harness', errorText(e)); status = 'model_error'; summary = 'Jev failed; no browser action was retried and no fallback model was used.'; break;
        }
        const action = candidates.find(a => a.id === decision.actionId);
        if (!action || !Number.isFinite(decision.probability) || decision.probability < this.config.minProbability || decision.probability > 1) {
          status = 'blocked'; summary = 'Unknown or insufficient-confidence action; ask the supervisor for a narrower mission.'; break;
        }
        s.recorder.event('decision', 'observation', `${decision.model}: ${action.id}, p=${decision.probability}, input_tokens=${decision.inputTokens}`);
        if (action.kind === 'done' || action.kind === 'blocked') {
          status = action.kind === 'done' ? 'stopped' : 'blocked'; summary = 'Jev yielded to the supervisor. This does not establish a test pass.'; break;
        }
        const signature = JSON.stringify([s.snapshot.url, s.snapshot.text, action.kind, action.target?.identity, action.value]);
        repeated = signature === previous ? repeated + 1 : 0; previous = signature;
        if (repeated >= 2) { status = 'blocked'; summary = 'Repeated action without an observed text/URL change; ask for a new strategy.'; break; }
        progress(action.description);
        try { await this.perform(s, action, combined); }
        catch (e) {
          if (combined.aborted) throw e;
          s.recorder.event('execution_error', 'harness', errorText(e));
          status = this.hasAnomaly(s) ? 'anomaly' : 'blocked';
          summary = 'Action did not complete reliably; its side effect may be unknown. No automatic retry.'; break;
        }
      }
      if (mission.stopOnAnomaly && this.hasAnomaly(s)) { status = 'anomaly'; summary = 'Anomaly detected; review evidence before recovery or replay.'; }
      if (status === 'stopped' && mission.checks.length) {
        s.checkpoints.push({ afterAction: s.recorder.actions.length, checks: mission.checks });
        s.recorder.write('checkpoints.json', s.checkpoints);
        if (!(await this.checks(s, mission.checks, combined))) { status = 'anomaly'; summary = 'An explicit supervisor-supplied assertion failed.'; }
      }
      if (!s.closed) {
        s.snapshot = await abortable(s.driver.observe(), combined);
        await abortable(s.driver.screenshot(), combined);
      }
    } catch (e) {
      status = combined.aborted ? (signal.aborted ? 'cancelled' : 'budget_exhausted') : 'harness_error';
      summary = errorText(e); s.recorder.event(status, 'harness', summary);
      if (combined.aborted) { cancelBrowser(); await s.driver.close().catch(() => {}); }
    } finally {
      clearTimeout(timer); combined.removeEventListener('abort', cancelBrowser); s.busy = false;
      s.reportedThrough = s.recorder.events.length;
    }
    return this.result(s, status, s.recorder.actions.length - startCount, summary);
  }
  async inspect(id: string, screenshot: boolean): Promise<RunResult & { image?: string }> {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Unknown session ID');
    if (s.busy) throw new Error('Session is busy');
    if (s.closed) return this.result(s, 'stopped', 0, 'Closed session: cached evidence only; no fresh screenshot.', false);
    s.busy = true;
    try {
      s.snapshot = await s.driver.observe();
      let image: string | undefined;
      if (screenshot) {
        if (!this.config.captureArtifacts) throw new Error('Screenshots require operator captureArtifacts=true; they can contain secrets.');
        const path = await s.driver.screenshot();
        if (path) image = readFileSync(path).toString('base64');
      }
      return { ...this.result(s, 'stopped', 0, 'Current page evidence; page content is untrusted.', false), image };
    } finally { s.busy = false; }
  }
  async replay(sourceId: string, resetConfirmed: boolean, signal = new AbortController().signal, progress: Progress = () => {}): Promise<RunResult & { replayOf: string }> {
    if (!resetConfirmed) throw new Error('Reset backend/test data and confirm equivalent preconditions before replay');
    if (!/^[0-9a-f-]{36}$/.test(sourceId)) throw new Error('Invalid run ID');
    const dir = join(resolve(this.root), 'runs', sourceId);
    const manifest = object(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')));
    const rawActions: unknown = JSON.parse(readFileSync(join(dir, 'actions.json'), 'utf8'));
    if (!Array.isArray(rawActions) || rawActions.length > this.config.maxSessionActions) throw new Error('Invalid replay action list');
    const executable = ['click', 'fill', 'select', 'press', 'burst_click', 'scroll', 'back', 'reload', 'wait'];
    const records = rawActions.map(raw => {
      const r = object(raw); const a = object(r.action);
      if (!executable.includes(String(a.kind))) throw new Error('Invalid replay action kind');
      if (typeof r.startedAtMs !== 'number' || !Number.isFinite(r.startedAtMs)) throw new Error('Invalid replay timestamp');
      if (a.value !== undefined) text(a.value, 'replay input', 8000, true);
      if (a.target) { const t = object(a.target); text(t.locator, 'replay selector', 2000); text(t.identity, 'target identity', 2000); text(t.label, 'target label', 200); }
      return r as unknown as ActionRecord;
    });
    let checkpoints: { afterAction: number; checks: Check[] }[] = [];
    try {
      const saved: unknown = JSON.parse(readFileSync(join(dir, 'checkpoints.json'), 'utf8'));
      if (!Array.isArray(saved) || saved.length > 200) throw new Error('Invalid checkpoints');
      checkpoints = saved.map(v => {
        const p = object(v);
        if (typeof p.afterAction !== 'number' || !Number.isInteger(p.afterAction) || p.afterAction < 0 || p.afterAction > records.length) throw new Error('Invalid checkpoint index');
        return { afterAction: p.afterAction, checks: parseMission({ objective: 'Replay saved assertions', checks: p.checks }, this.config).checks };
      });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const opened = await this.open(text(manifest.startUrl, 'start URL', 4000), signal);
    const s = this.get(opened.sessionId); s.busy = true;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.config.maxMissionMs)]);
    const cancel = () => { s.closed = true; void s.driver.close().catch(() => {}); };
    combined.addEventListener('abort', cancel, { once: true });
    let status: RunStatus = 'stopped'; let summary = 'Recorded actions replayed without model calls; compare evidence. Reproduction is not automatically confirmed.';
    s.recorder.event('replay_source', 'observation', sourceId);
    const start = Date.now(); const originalStart = records[0]?.startedAtMs ?? start;
    try {
      for (const checkpoint of checkpoints.filter(p => p.afterAction === 0)) {
        if (!(await this.checks(s, checkpoint.checks, combined))) status = 'anomaly';
      }
      for (const record of records) {
        await pause(Math.max(0, start + record.startedAtMs - originalStart - Date.now()), combined);
        progress(`Replaying action ${s.recorder.actions.length + 1}/${records.length}`);
        await this.perform(s, record.action, combined, true);
        for (const p of checkpoints.filter(p => p.afterAction === s.recorder.actions.length)) {
          if (!(await this.checks(s, p.checks, combined))) status = 'anomaly';
        }
        if (this.hasAnomaly(s)) { status = 'anomaly'; summary = 'A runtime signal or saved assertion recurred; compare it with the source evidence.'; break; }
      }
      s.snapshot = await abortable(s.driver.observe(), combined);
      await abortable(s.driver.screenshot(), combined);
    } catch (e) {
      status = combined.aborted ? (signal.aborted ? 'cancelled' : 'budget_exhausted') : 'blocked';
      summary = `Replay stopped without retargeting: ${errorText(e)}`; s.recorder.event('replay_stopped', 'harness', summary);
    } finally {
      combined.removeEventListener('abort', cancel); s.busy = false;
      s.checkpoints = checkpoints.filter(p => p.afterAction <= s.recorder.actions.length);
      s.recorder.write('checkpoints.json', s.checkpoints);
      if (combined.aborted) { cancel(); await s.driver.close().catch(() => {}); }
    }
    return { ...this.result(s, status, s.recorder.actions.length, summary), replayOf: sourceId };
  }
  async close(id: string): Promise<{ sessionId: string; closed: true }> {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Unknown session ID');
    if (s.busy) throw new Error('Cancel the active operation before closing its session');
    s.closed = true; await s.driver.close();
    return { sessionId: id, closed: true };
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async s => { s.closed = true; await s.driver.close().catch(() => {}); }));
  }
}
