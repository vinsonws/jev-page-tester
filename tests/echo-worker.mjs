import { createInterface } from 'node:readline';
const pending = new Set();
const reply = data => process.stdout.write(JSON.stringify(data) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'cancel') { if (pending.delete(id)) reply({ id, type: 'result', data: { status: 'cancelled' } }); return; }
  if (method === 'wait') { pending.add(id); reply({ id, type: 'progress', message: 'waiting' }); return; }
  if (method === 'malformed') { process.stdout.write('not-json\n'); return; }
  reply({ id, type: 'progress', message: 'working' });
  reply({ id, type: 'result', data: params });
});
