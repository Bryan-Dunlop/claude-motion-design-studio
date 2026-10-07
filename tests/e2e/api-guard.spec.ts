// The local API answers only the editor on this computer: not a page from another site, not another host name
// (DNS rebinding), and not a body type another site's page can send without asking first.
import { expect, test } from '@playwright/test';

test('the API refuses other sites and other host names, and still serves the editor', async ({ request, baseURL }) => {
  expect((await request.get('/api/projects')).status()).toBe(200);
  expect((await request.get('/api/projects', { headers: { Origin: baseURL! } })).status()).toBe(200);
  expect((await request.get('/api/projects', { headers: { Origin: 'http://attacker.example' } })).status()).toBe(403);
  const port = new URL(baseURL!).port;
  expect((await request.get('/api/projects', { headers: { Host: `attacker.example:${port}` } })).status()).toBe(403);
  // A cross-site "simple" upload (text/plain) is not read.
  const r = await request.post('/api/assets', { headers: { 'Content-Type': 'text/plain', 'X-Filename': 'note.txt' }, data: 'hello' });
  expect(r.status()).toBe(400);
});
