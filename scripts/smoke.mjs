import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.SCRAPER_URL || 'http://127.0.0.1:8787';
const headers = { authorization: `Bearer ${process.env.API_KEY}`, 'content-type': 'application/json' };
const health = await fetch(`${base}/health`).then(r => r.json());
assert.equal(health.engine, 'patchright');
assert.equal((await fetch(`${base}/v1/search?q=hello`)).status, 401);
const response = await fetch(`${base}/v1/scrape`, { method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com', formats: ['text', 'markdown', 'screenshot'], cache: false }) });
const page = await response.json();
assert.equal(response.status, 200, JSON.stringify(page));
assert.match(page.data.text, /Example Domain/);
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/example.png', Buffer.from(page.data.screenshot, 'base64'));
console.log(JSON.stringify({ check: 'public page', status: page.status, title: page.title, elapsed_ms: page.elapsed_ms }));
const blocked = await fetch(`${base}/v1/scrape`, { method: 'POST', headers, body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }) });
assert.equal(blocked.status, 403);
console.log(JSON.stringify({ check: 'private destination', status: blocked.status }));
const search = await fetch(`${base}/search.json?q=Patchright+GitHub&num=5&no_cache=true`, { headers });
const results = await search.json();
if (!search.ok) {
  console.log(JSON.stringify({ check: 'live Google', status: search.status, code: results.code, error: results.error }));
  process.exitCode = 2;
} else {
  assert.ok(results.organic_results.length > 0);
  console.log(JSON.stringify({ check: 'live Google', status: search.status, count: results.organic_results.length, results: results.organic_results.map(({ title, link }) => ({ title, link })) }));
}
