import { readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import type { Config, Mission, Check } from './types.js';
import { object, text, integer, number, flag, strings } from './validation.js';

export function parseConfig(raw: unknown): Config {
  const c = object(raw, 'configuration');
  const origins = (v: unknown) => strings(v, []).map(s => {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol) || s !== u.origin) throw new Error(`Use exact HTTP(S) origins, without paths: ${s}`);
    return u.origin;
  });
  const allowedOrigins = origins(c.allowedOrigins);
  if (!allowedOrigins.length) throw new Error('allowedOrigins must explicitly list your authorized test origins');
  return {
    allowedOrigins, resourceOrigins: origins(c.resourceOrigins),
    headless: flag(c.headless, false), captureArtifacts: flag(c.captureArtifacts, false),
    allowRiskyActions: flag(c.allowRiskyActions, false),
    blockedSelectors: strings(c.blockedSelectors, ['[data-qa-private]']),
    maxActionsPerMission: integer(c.maxActionsPerMission, 30, 1, 100),
    maxMissionMs: integer(c.maxMissionMs, 120000, 1000, 180000),
    maxSessionActions: integer(c.maxSessionActions, 200, 1, 1000),
    maxBurstClicks: integer(c.maxBurstClicks, 3, 1, 10),
    minProbability: number(c.minProbability, 0.65, 0, 1),
    actionTimeoutMs: integer(c.actionTimeoutMs, 5000, 100, 15000),
    settleMs: integer(c.settleMs, 250, 0, 3000),
    jevTimeoutMs: integer(c.jevTimeoutMs, 10000, 100, 30000),
    maxSessions: integer(c.maxSessions, 3, 1, 5),
    model: text(c.model ?? process.env.JEV_MODEL ?? 'jev-1.13.0', 'model', 100),
    executablePath: process.env.QA_BROWSER_EXECUTABLE || undefined,
    cdpEndpoint: process.env.QA_CDP_ENDPOINT || (c.cdpEndpoint === undefined ? undefined : text(c.cdpEndpoint, 'cdpEndpoint', 300)),
    browserProxy: c.browserProxy === undefined ? undefined : text(c.browserProxy, 'browserProxy', 1000),
  };
}
export function loadConfig(root: string): Config {
  try { loadEnvFile(resolve(root, '.env')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const file = resolve(root, process.env.QA_CONFIG || 'qa.config.json');
  try { return parseConfig(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Copy qa.config.example.json to qa.config.json and explicitly configure your test origins.');
    throw e;
  }
}
export function parseMission(raw: unknown, c: Config): Mission {
  const m = object(raw, 'mission');
  const list = m.inputs ?? [];
  if (!Array.isArray(list) || list.length > 8) throw new Error('At most 8 input cases per mission');
  const checks = m.checks ?? [];
  if (!Array.isArray(checks) || checks.length > 10) throw new Error('At most 10 checks per mission');
  return {
    objective: text(m.objective, 'objective', 4000),
    inputs: list.map(x => {
      const v = object(x);
      return { field: text(v.field, 'field', 100), value: text(v.value, 'value', 8000, true) };
    }),
    maxActions: integer(m.maxActions, Math.min(20, c.maxActionsPerMission), 1, c.maxActionsPerMission),
    maxDurationMs: integer(m.maxDurationMs, c.maxMissionMs, 1000, c.maxMissionMs),
    burstClicks: integer(m.burstClicks, 1, 1, c.maxBurstClicks),
    allowReload: flag(m.allowReload, false), stopOnAnomaly: flag(m.stopOnAnomaly, true),
    checks: checks.map(x => {
      const v = object(x);
      if (!['count', 'text', 'value'].includes(String(v.kind))) throw new Error('Unknown check kind');
      return {
        kind: v.kind as Check['kind'], selector: text(v.selector, 'selector', 300),
        label: text(v.label, 'check label', 200),
        expected: v.kind === 'count' ? integer(v.expected, -1, 0, 10000) : text(v.expected, 'expected', 1000, true),
      };
    }),
  };
}
