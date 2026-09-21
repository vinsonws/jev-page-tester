export type BrowserMode = 'launch-isolated' | 'cdp-isolated' | 'existing-tab';
export interface Config {
  allowedOrigins: string[];
  resourceOrigins: string[];
  headless: boolean;
  captureArtifacts: boolean;
  allowRiskyActions: boolean;
  blockedSelectors: string[];
  maxActionsPerMission: number;
  maxMissionMs: number;
  maxSessionActions: number;
  maxBurstClicks: number;
  minProbability: number;
  actionTimeoutMs: number;
  settleMs: number;
  jevTimeoutMs: number;
  maxSessions: number;
  model: string;
  executablePath?: string;
  browserProxy?: string;
  cdpEndpoint?: string;
  /** Operator-controlled defaults. Tool parameters cannot enable existing-tab access. */
  browserMode: BrowserMode;
  allowExistingTab: boolean;
  extensionConnectTimeoutMs: number;
}
export interface Target {
  id: string; locator: string; tag: string; role: string; label: string; type: string;
  identity: string; value?: string; options?: { label: string; value: string }[];
}
export interface Snapshot {
  id: string; url: string; title: string; text: string; targets: Target[];
  truncated: boolean; limitations: string[];
}
export type ActionKind = 'click' | 'fill' | 'select' | 'press' | 'burst_click' |
  'scroll' | 'back' | 'reload' | 'wait' | 'done' | 'blocked';
export interface Candidate {
  id: string; kind: ActionKind; description: string; target?: Target; value?: string; count?: number;
}
export interface Check {
  kind: 'count' | 'text' | 'value'; selector: string; expected: string | number; label: string;
}
export interface Mission {
  objective: string; inputs: { field: string; value: string }[];
  maxActions: number; maxDurationMs: number; burstClicks: number;
  allowReload: boolean; stopOnAnomaly: boolean; checks: Check[];
}
export interface Decision { actionId: string; probability: number; model: string; inputTokens: number; }
export interface Decider {
  decide(snapshot: Snapshot, candidates: Candidate[], mission: Mission,
    history: string[], signal: AbortSignal): Promise<Decision>;
}
export interface EvidenceEvent {
  id: number; at: string; elapsedMs: number; kind: string;
  category: 'runtime' | 'signal' | 'policy' | 'harness' | 'observation'; message: string;
}
export interface ActionRecord {
  index: number; startedAtMs: number; snapshotUrl: string; action: Candidate;
  status: 'started' | 'ok' | 'error'; clickTimesMs?: number[]; error?: string;
}
export type RunStatus = 'stopped' | 'budget_exhausted' | 'anomaly' | 'blocked' |
  'cancelled' | 'model_error' | 'harness_error';
export interface RunResult {
  sessionId: string; status: RunStatus; actionsExecuted: number; totalActions: number;
  summary: string; events: EvidenceEvent[]; snapshot?: Snapshot; artifactsDir: string;
  browserMode?: BrowserMode;
  /** No result from an exploratory run is an application-wide PASS. */
  verdict: 'not_evaluated';
}
export type Progress = (message: string) => void;
