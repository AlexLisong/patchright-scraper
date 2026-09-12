import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Scraper } from '../src/scraper.mjs';
import { createEgress, targetUrl, resolvePublic } from '../src/egress.mjs';
import { parse, scrapeSchema } from '../src/contracts.mjs';
import { extractGoogle, extractDocument } from '../src/extract.mjs';

test('Patchright renders, extracts, isolates sessions, enforces redirect policy, and recovers from timeout', { timeout: 90000 }, async t => {
  let privateRequests = 0;
  const fixture = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/' }); return res.end(); }
    if (req.url === '/private') privateRequests++;
    if (req.url === '/cookie') { res.setHeader('content-type', 'text/html'); return res.end(`<body>${req.headers.cookie || 'clean'}</body>`); }
    if (req.url === '/slow') return;
    res.setHeader('content-type', 'text/html');
    res.setHeader('set-cookie', 'fixture=1');
    res.end(`<html><head><title>Fixture</title></head><body><h1>Original</h1><a href="/one">One</a><a href="/two">Two</a><script>setTimeout(() => {document.querySelector("h1").textContent="Rendered";document.querySelector("h1").id="ready"},80);fetch("http://127.0.0.1:${port}/private").catch(()=>{});</script></body></html>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const port = fixture.address().port;
  // Test-only dependency injection: allow precisely the controlled fixture.
  // Production has no environment switch to permit private addresses.
  const validate = input => { const u = new URL(input); return u.hostname === 'fixture.test' && u.port === String(port) ? u : targetUrl(input); };
  const resolve = async host => host === 'fixture.test' ? { address: '127.0.0.1', family: 4 } : resolvePublic(host);
  const scraper = await new Scraper({ headless: process.env.HEADLESS === 'true', timeout: 15000 }, { validate, resolve, createEgress: () => createEgress({ validate, resolve }) }).start();
  t.after(() => scraper.close());
  const url = `http://fixture.test:${port}`;
  const options = extra => parse(scrapeSchema, { url, cache: false, ...extra });
  const rendered = await scraper.scrape(options({ wait_for: '#ready', formats: ['text', 'html', 'markdown', 'screenshot'], extract_rules: { title: 'h1', links: { selector: 'a', type: 'list', output: 'href' } } }));
  assert.equal(rendered.data.extraction.title, 'Rendered');
  assert.deepEqual(rendered.data.extraction.links, ['/one', '/two']);
  assert.match(rendered.data.markdown, /# Rendered/);
  assert.equal(Buffer.from(rendered.data.screenshot, 'base64').subarray(1, 4).toString(), 'PNG');
  const staticPage = await scraper.scrape(options({ render_js: false }));
  assert.match(staticPage.data.text, /Original/);
  const isolated = await scraper.scrape(options({ url: `${url}/cookie` }));
  assert.equal(isolated.data.text.trim(), 'clean');
  assert.equal(privateRequests, 0);
  await assert.rejects(scraper.scrape(options({ url: `${url}/redirect` })), { code: 'TARGET_BLOCKED' });
  await assert.rejects(scraper.scrape(options({ url: `${url}/slow`, timeout: 1000 })), { code: 'TIMEOUT' });
  assert.equal(scraper.queue.active, 0);
  assert.equal((await scraper.scrape(options({ render_js: false }))).status, 200);
  const browser = await scraper.browser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<div id="search"><div class="g"><a href="https://example.com/first"><h3>First result</h3></a><cite>example.com</cite><div class="VwiC3b">First snippet</div></div><div class="g"><a href="https://example.org/second"><h3>Second result</h3></a><div class="VwiC3b">Second snippet</div></div></div>');
    const parsed = await page.evaluate(extractGoogle, { start: 10, num: 2 });
    assert.deepEqual(parsed.organic_results.map(r => [r.position, r.title, r.snippet]), [[11, 'First result', 'First snippet'], [12, 'Second result', 'Second snippet']]);
    await page.setContent('<div id="search"><div><div data-text-ad><a href="https://ad.example.com"><h3>Ad</h3></a></div></div><div><a href="https://example.com"><h3>Managing automated queries</h3></a></div></div>');
    const organic = await page.evaluate(extractGoogle, {});
    assert.equal(organic.organic_results.length, 1);
    assert.equal(organic.organic_results[0].title, 'Managing automated queries');
    await page.setContent(`<div>${'<p data-value="' + 'x'.repeat(200000) + '">value</p>'.repeat(3)}</div>`);
    const bounded = await page.evaluate(extractDocument, { rules: { all: { selector: 'p', output: 'data-value', type: 'list' }, duplicate: { selector: 'p', output: 'data-value', type: 'list' } } });
    assert.ok(JSON.stringify(bounded.extraction).length < 251000);
    assert.equal(bounded.truncated, true);
    await page.setContent('<form id="captcha-form">Our systems have detected unusual traffic</form>');
    assert.match((await page.evaluate(extractGoogle, {})).blocked, /challenge/);
    await page.setContent('<form action="https://consent.google.com/save">Consent</form>');
    assert.match((await page.evaluate(extractGoogle, {})).blocked, /consent/);
  } finally { await context.close(); }
  await browser.close();
  assert.equal((await scraper.scrape(options({ render_js: false }))).status, 200);
});
