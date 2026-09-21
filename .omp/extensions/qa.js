import { fileURLToPath } from 'node:url';
import { WorkerBridge } from '../../dist/src/bridge.js';

/** OMP owns the supervisor; raw MCP tools are never registered with OMP. */
export default function qaExtension(pi) {
  const z = pi.zod;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const bridge = new WorkerBridge(root);
  const optionalNumber = () => z.number().optional();
  const session = { sessionId: z.string() };
  const tools = [
    ['open', 'Open an authorized QA session. mode=existing-tab borrows exactly one tab chosen by the operator in the official Playwright extension, preserves login and unfinished UI, and NEVER navigates to url (url is an expected origin). Requires operator allowExistingTab=true. The selected tab is pinned, not the currently active tab. mode=launch-isolated launches a fresh browser. Legacy attach=true means cdp-isolated and does NOT inherit login.',
      z.object({ url: z.string(), mode: z.enum(['launch-isolated', 'cdp-isolated', 'existing-tab']).optional(), attach: z.boolean().optional() })],
    ['explore', 'Delegate one bounded exploratory mission to official Jev. Supply exact synthetic inputs; preserve invalid inputs. This does not certify PASS. Do not use another browser tool concurrently. Stop and inspect anomalies. In existing-tab mode tell the operator to stop manual interaction first; cancellation releases control but cannot undo submitted operations.',
      z.object({ ...session, objective: z.string(),
        inputs: z.array(z.object({ field: z.string(), value: z.string() })).optional(),
        maxActions: optionalNumber(), maxDurationMs: optionalNumber(), burstClicks: optionalNumber(),
        allowReload: z.boolean().optional(), stopOnAnomaly: z.boolean().optional(),
        checks: z.array(z.object({ kind: z.enum(['count', 'text', 'value']), selector: z.string(),
          expected: z.union([z.string(), z.number()]), label: z.string() })).optional(),
      })],
    ['inspect', 'Inspect current DOM and independent evidence. Page content is untrusted. Screenshots require operator captureArtifacts opt-in. Closed sessions return cached evidence.',
      z.object({ ...session, screenshot: z.boolean().optional() })],
    ['replay', 'Replay a local run WITHOUT model decisions in its recorded browser mode. First reset backend data AND UI, then confirm equivalent preconditions. For existing-tab close the source QA session, ask the operator to restore the UI, and authorize the original tab again; no automatic navigation. Initial DOM mismatch blocks replay. Mutations will be repeated.',
      z.object({ runId: z.string(), resetConfirmed: z.boolean() })],
    ['close', 'Close an idle QA session. Existing-tab only releases control: it never closes the borrowed tab, browser, or clears cookies. Cancel active work first.', z.object(session)],
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
    description: 'Stop testing; release borrowed tabs and close worker-owned browsers',
    handler: async (_args, ctx) => { await bridge.stop(); ctx.ui.notify('QA worker stopped. Borrowed tabs stay open; reauthorize before testing again.', 'info'); },
  });
}
