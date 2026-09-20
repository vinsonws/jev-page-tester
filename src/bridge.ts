import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { object, errorText } from './validation.js';
import type { Progress } from './types.js';

interface Pending {
  resolve(value: unknown): void; reject(reason: Error): void;
  progress: Progress; cleanup(): void;
}
/** Local stdio only. No network listener, shell, or detached browser service. */
export class WorkerBridge {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  constructor(readonly root: string, private readonly workerPath = join(root, 'dist', 'src', 'worker.js')) {}
  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(process.env.QA_NODE_PATH || 'node', [this.workerPath, this.root], {
      cwd: this.root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    // Drain stderr without reflecting arbitrary logs/secrets into model context.
    child.stderr.on('data', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        if (line.length > 2_000_000) throw new Error('Worker response exceeded protocol budget');
        const response = object(JSON.parse(line));
        const pending = this.pending.get(String(response.id));
        if (!pending) return;
        if (response.type === 'progress') { pending.progress(String(response.message)); return; }
        this.pending.delete(String(response.id)); pending.cleanup();
        if (response.type === 'result') pending.resolve(response.data);
        else pending.reject(new Error(String(response.error || 'Worker request failed')));
      } catch (e) { this.failAll(new Error(`Invalid worker protocol: ${errorText(e)}`)); child.kill('SIGTERM'); }
    });
    child.once('error', e => { if (this.child === child) this.child = undefined; this.failAll(new Error(`Cannot start Node worker: ${e.message}`)); });
    child.once('exit', (code, signal) => {
      lines.close();
      if (this.child === child) { this.child = undefined; this.failAll(new Error(`Worker exited (${code ?? signal}). Check Node >=22.16, npm run build and qa.config.json. Browser sessions must be reopened.`)); }
    });
    return child;
  }
  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
  }
  call(method: string, params: unknown, signal?: AbortSignal, progress: Progress = () => {}): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('Cancelled before dispatch'));
    const child = this.start(); const id = randomUUID();
    return new Promise((resolve, reject) => {
      let cancelTimer: NodeJS.Timeout | undefined;
      const abort = () => {
        child.stdin.write(`${JSON.stringify({ id, method: 'cancel' })}\n`);
        // A hung renderer must not keep OMP's tool call alive indefinitely.
        cancelTimer = setTimeout(() => { this.failAll(new Error('Cancelled; unresponsive worker terminated. Reopen browser sessions.')); child.kill('SIGKILL'); }, 2500);
      };
      const deadline = setTimeout(() => {
        this.failAll(new Error('Worker hard deadline exceeded; sessions terminated.')); child.kill('SIGKILL');
      }, 195000);
      this.pending.set(id, { resolve, reject, progress, cleanup: () => {
        clearTimeout(deadline); clearTimeout(cancelTimer); signal?.removeEventListener('abort', abort);
      } });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (error) { const pending = this.pending.get(id); pending?.cleanup(); this.pending.delete(id); reject(error); }
      });
    });
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.failAll(new Error('Worker stopped by operator/session lifecycle'));
    await new Promise<void>(resolve => {
      const hardKill = setTimeout(() => child.kill('SIGKILL'), 2500);
      child.once('exit', () => { clearTimeout(hardKill); resolve(); });
      child.kill('SIGTERM');
    });
  }
}
