import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { JevDecider } from './jev.js';
import { Runner } from './runner.js';
import { object, text, flag, errorText } from './validation.js';
import { makeRedactor } from './policy.js';

async function main(): Promise<void> {
  const root = resolve(process.argv[2] || process.cwd());
  const config = loadConfig(root); const redact = makeRedactor();
  const decider = new JevDecider(config); const runner = new Runner(root, config, decider);
  const controllers = new Map<string, AbortController>();
  const reply = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const lines = createInterface({ input: process.stdin });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    const hard = setTimeout(() => process.exit(1), 2000); hard.unref();
    for (const c of controllers.values()) c.abort(new Error('Worker shutdown'));
    await runner.closeAll(); await decider.close(); lines.close(); process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  lines.once('close', () => void shutdown());
  lines.on('line', line => { void (async () => {
    let id = ''; let ownsController = false;
    try {
      if (line.length > 100000) throw new Error('Request exceeded protocol budget');
      const request = object(JSON.parse(line)); id = text(request.id, 'request ID', 100);
      if (request.method === 'cancel') { controllers.get(id)?.abort(new Error('Operator cancelled')); return; }
      if (controllers.has(id) || controllers.size >= 8 || stopping) throw new Error('Worker is busy or shutting down');
      const p = object(request.params ?? {});
      const controller = new AbortController(); controllers.set(id, controller); ownsController = true;
      const progress = (message: string) => reply({ id, type: 'progress', message: redact(message) });
      let data: unknown;
      switch (request.method) {
        case 'open': data = await runner.open(text(p.url, 'URL', 4000), controller.signal, flag(p.attach, false)); break;
        case 'explore': data = await runner.explore(text(p.sessionId, 'sessionId', 100), p, controller.signal, progress); break;
        case 'inspect': data = await runner.inspect(text(p.sessionId, 'sessionId', 100), flag(p.screenshot, false)); break;
        case 'replay': data = await runner.replay(text(p.runId, 'runId', 100), flag(p.resetConfirmed, false), controller.signal, progress); break;
        case 'close': data = await runner.close(text(p.sessionId, 'sessionId', 100)); break;
        default: throw new Error('Unknown method');
      }
      reply({ id, type: 'result', data });
    } catch (e) { reply({ id, type: 'error', error: redact(errorText(e)) }); }
    finally { if (ownsController) controllers.delete(id); }
  })().catch(() => void shutdown()); });
}
main().catch(e => { process.stderr.write(`${errorText(e)}\n`); process.exitCode = 1; });
