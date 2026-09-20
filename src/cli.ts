import { startFixture } from '../examples/fixture.js';
import { parseConfig } from './config.js';
import { Runner } from './runner.js';
import { ScriptedDecider } from './demo-decider.js';
import { JevDecider } from './jev.js';
import { loadEnvFile } from 'node:process';
import { errorText } from './validation.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'fixture') {
    const fixture = await startFixture(4173);
    console.log(`Intentional local fault fixture: ${fixture.url}`);
    process.once('SIGINT', () => void fixture.close());
    process.once('SIGTERM', () => void fixture.close());
    return;
  }
  if (command !== 'demo') { console.log('Commands: demo [--headless] [--live], fixture. Use OMP qa_* tools for real testing.'); return; }
  try { loadEnvFile(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const fixture = await startFixture();
  const config = parseConfig({ allowedOrigins: [fixture.url], headless: process.argv.includes('--headless'), captureArtifacts: true });
  const live = process.argv.includes('--live');
  const decider = live ? new JevDecider(config) : new ScriptedDecider((c, i) => i === 0 ? c.find(a => a.kind === 'fill') :
    i === 1 ? c.find(a => a.kind === 'burst_click' && a.target?.label === 'Save') : c.find(a => a.kind === 'done'));
  const runner = new Runner(process.cwd(), config, decider);
  try {
    console.log(live ? 'LIVE official Jev test (billable).' : 'OFFLINE scripted-decider demo; this does not test Jev or Muse Spark.');
    const opened = await runner.open(fixture.url);
    const result = await runner.explore(opened.sessionId, {
      objective: 'Fill Title using the supplied value, then attempt three consecutive Save clicks. Choose done after this one branch. Do not correct the duplicate-submit bug.',
      inputs: [{ field: 'Title', value: 'jev-demo-record' }], burstClicks: 3, maxActions: 6,
      checks: [{ kind: 'count', selector: '#records li', expected: 1, label: 'A single intended submission must not produce duplicate records (fixture expectation)' }],
    }, undefined, message => console.log(message));
    console.log(JSON.stringify({ mode: live ? 'official-jev' : 'scripted-test-double', status: result.status,
      summary: result.summary, artifactsDir: result.artifactsDir }, null, 2));
    if (result.status !== 'anomaly') process.exitCode = 1;
  } finally { await runner.closeAll(); if (decider instanceof JevDecider) await decider.close(); await fixture.close(); }
}
main().catch(e => { console.error(errorText(e)); process.exitCode = 1; });
