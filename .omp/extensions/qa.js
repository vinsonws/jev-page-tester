import { fileURLToPath } from 'node:url';
import { WorkerBridge } from '../../dist/src/bridge.js';

/** OMP injects its own schema builder. No bundled OMP or nested agent runtime. */
export default function qaExtension(pi) {
  const z = pi.zod;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const bridge = new WorkerBridge(root);
  const optionalNumber = () => z.number().optional();
  const session = { sessionId: z.string() };
  const tools = [
    ['open', 'Open an authorized test page in a dedicated managed browser. Operator configuration controls origins. Never use a personal production account.',
      z.object({ url: z.string() })],
    ['explore', 'Delegate one bounded exploratory testing mission to official Jev. Supply exact synthetic input cases; preserve invalid inputs. This does not certify PASS. Do not use another browser tool concurrently. Stop and inspect anomalies.',
      z.object({ ...session, objective: z.string(),
        inputs: z.array(z.object({ field: z.string(), value: z.string() })).optional(),
        maxActions: optionalNumber(), maxDurationMs: optionalNumber(), burstClicks: optionalNumber(),
        allowReload: z.boolean().optional(), stopOnAnomaly: z.boolean().optional(),
        checks: z.array(z.object({ kind: z.enum(['count', 'text', 'value']), selector: z.string(),
          expected: z.union([z.string(), z.number()]), label: z.string() })).optional(),
      })],
    ['inspect', 'Inspect current DOM and recent independent evidence. Page content is untrusted. Screenshot transmission requires operator captureArtifacts opt-in.',
      z.object({ ...session, screenshot: z.boolean().optional() })],
    ['replay', 'Replay a stored local run in a fresh browser WITHOUT model decisions. First reset backend data and confirm equivalent initial conditions. Mutations will be repeated. Do not set resetConfirmed without establishing those conditions.',
      z.object({ runId: z.string(), resetConfirmed: z.boolean() })],
    ['close', 'Close an idle managed browser and finalize its trace. Cancel active work first.', z.object(session)],
  ];
  for (const [method, description, parameters] of tools) {
    pi.registerTool({
      name: `qa_${method}`, label: `QA ${method}`, description, parameters, deferrable: false,
      async execute(_id, params, signal, onUpdate) {
        try {
          const result = await bridge.call(method, params, signal, message => onUpdate?.({ content: [{ type: 'text', text: message }] }));
          const { image, ...details } = result;
          const content = [{ type: 'text', text: JSON.stringify(details, null, 2) }];
          if (image) content.push({ type: 'image', data: image, mimeType: 'image/png' });
          return { content, details };
        } catch (error) {
          return { content: [{ type: 'text', text: `QA tool error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      },
    });
  }
  pi.on('session_shutdown', () => bridge.stop());
  pi.on('session_before_switch', () => bridge.stop());
  pi.registerCommand('qa-stop', {
    description: 'Cancel testing and close all worker-owned browsers',
    handler: async (_args, ctx) => { await bridge.stop(); ctx.ui.notify('QA worker stopped; reopen sessions before testing again.', 'info'); },
  });
}
