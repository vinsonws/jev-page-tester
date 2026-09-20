import type { Candidate, Decider, Decision, Mission, Snapshot } from './types.js';
/** Deterministic TEST DOUBLE. Never used by the production worker. */
export class ScriptedDecider implements Decider {
  calls = 0;
  constructor(private readonly select: (candidates: Candidate[], call: number) => Candidate | undefined) {}
  async decide(_s: Snapshot, candidates: Candidate[], _m: Mission, _history: string[], signal: AbortSignal): Promise<Decision> {
    signal.throwIfAborted();
    const selected = this.select(candidates, this.calls++);
    if (!selected) throw new Error('Scripted fixture could not find its expected candidate');
    return { actionId: selected.id, probability: 1, model: 'scripted-test-double-NOT-JEV', inputTokens: 0 };
  }
}
