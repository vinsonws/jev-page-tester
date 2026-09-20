import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const fixtureHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Jev QA fault fixture</title></head>
<body><h1>Jev QA fault fixture</h1>
<p>This local demo intentionally contains bugs. Never deploy it publicly.</p>
<form id="form"><label for="title">Title</label><input id="title" data-testid="title">
<button data-testid="save" type="submit">Save</button></form>
<p>Records: <span id="count">0</span></p><ul id="records"></ul>
<button id="error">Trigger error</button><button id="network">Trigger server error</button>
<button id="delete">Delete all records</button>
<div data-qa-private>private-canary-do-not-send</div>
<input type="password" value="password-canary" aria-label="Password">
<script>
const title = document.querySelector('#title');
const records = document.querySelector('#records');
function add() { const li = document.createElement('li'); li.textContent = title.value; records.append(li); document.querySelector('#count').textContent = records.children.length; }
document.querySelector('#form').onsubmit = e => { e.preventDefault(); setTimeout(add, 80); }; // BUG: no duplicate-submit guard.
document.querySelector('#error').onclick = () => setTimeout(() => { throw new Error('fixture: uncaught application error'); }, 10);
document.querySelector('#network').onclick = () => fetch('/fail');
document.querySelector('#delete').onclick = () => { records.innerHTML = ''; document.querySelector('#count').textContent = '0'; };
</script></body></html>`;
export async function startFixture(port = 0): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === '/fail') { response.writeHead(503, { 'Content-Type': 'text/plain' }); response.end('Intentional fixture failure'); return; }
    if (request.url !== '/') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(fixtureHtml);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(e => e ? reject(e) : resolve()); }) };
}
