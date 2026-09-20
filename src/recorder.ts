import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactDeep } from './policy.js';
import type { ActionRecord, EvidenceEvent, RunResult } from './types.js';

export class Recorder {
  readonly id = randomUUID();
  readonly started = Date.now();
  readonly dir: string;
  readonly events: EvidenceEvent[] = [];
  readonly actions: ActionRecord[] = [];
  private eventLimitWritten = false;
  constructor(root: string, startUrl: string, readonly redact: (s: string) => string, model: string) {
    this.dir = join(root, 'runs', this.id);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.write('run.json', { schemaVersion: 1, id: this.id, startUrl, requestedModel: model, createdAt: new Date().toISOString() });
    this.write('actions.json', []);
  }
  write(name: string, data: unknown): void {
    if (!/^[a-z0-9.-]+$/i.test(name)) throw new Error('Invalid artifact name');
    const path = join(this.dir, name);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(redactDeep(data, this.redact), null, 2), { mode: 0o600 });
    renameSync(temporary, path);
  }
  event(kind: string, category: EvidenceEvent['category'], message: string): EvidenceEvent | undefined {
    if (this.events.length >= 1500) {
      if (this.eventLimitWritten) return;
      this.eventLimitWritten = true;
      kind = 'event_limit'; category = 'harness'; message = 'Event budget exhausted; subsequent events are omitted.';
    }
    const event: EvidenceEvent = { id: this.events.length + 1, at: new Date().toISOString(),
      elapsedMs: Date.now() - this.started, kind, category, message: this.redact(message).slice(0, 2000) };
    this.events.push(event);
    appendFileSync(join(this.dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  }
  start(action: ActionRecord): void {
    this.actions.push(action);
    // Persist the attempt before a mutation; a renderer/worker crash must not erase it.
    this.write('actions.json', this.actions);
  }
  complete(): void { this.write('actions.json', this.actions); }
  report(result: RunResult): void {
    const { snapshot: _snapshot, ...summary } = result;
    this.write('report.json', summary);
    const body = [`# Exploration ${this.id}`, '', `Status: **${result.status}**`, '',
      result.summary, '', '**This is not an application-wide PASS.**', '',
      `Actions attempted in this session: ${this.actions.length}`, '', '## Recent evidence', '',
      ...result.events.map(e => `- [${e.id}] ${e.category}/${e.kind}: ${e.message.replace(/[\r\n]/g, ' ')}`), '',
      'Inspect actions.json and events.jsonl before replay. Reset backend data separately.', ''].join('\n');
    writeFileSync(join(this.dir, 'report.md'), body, { mode: 0o600 });
  }
}
