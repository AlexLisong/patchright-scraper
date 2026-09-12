import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { isPublicAddress, targetUrl, resolvePublic, createEgress } from '../src/egress.mjs';
import { WorkQueue, ResultCache } from '../src/resources.mjs';
import { parse, scrapeSchema, searchSchema, parseBee } from '../src/contracts.mjs';
import { createApp } from '../src/app.mjs';

test('blocks private, reserved, encoded, and mixed DNS destinations', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '168.63.129.16', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', 'fec0::1', '64:ff9b:1::a9fe:a9fe', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  for (const url of ['file:///etc/passwd', 'ftp://example.com', 'http://user:pass@example.com', 'http://localhost', 'http://example.com:8787']) assert.throws(() => targetUrl(url));
  for (const url of ['http://2130706433', 'http://0x7f000001', 'http://[::ffff:127.0.0.1]']) await assert.rejects(resolvePublic(targetUrl(url).hostname), { code: 'TARGET_BLOCKED' });
  await assert.rejects(resolvePublic('mixed.test', async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]), { code: 'TARGET_BLOCKED' });
});

test('egress denies both HTTP and CONNECT private requests', async t => {
  const egress = await createEgress();
  t.after(() => egress.close());
  const proxy = new URL(egress.url);
  const status = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: proxy.hostname, port: proxy.port, path: 'http://169.254.169.254/latest/meta-data/' }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(status, 403);
  const result = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) }, () => socket.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n'));
    socket.on('data', data => { resolve(data.toString()); socket.destroy(); });
    socket.on('error', reject);
  });
  assert.match(result, /403 Forbidden/);
});

test('strict compatibility parsing rejects unsupported and malformed values', () => {
  assert.equal(parseBee({ url: 'https://example.com', render_js: 'false' }).render_js, false);
  assert.throws(() => parseBee({ url: 'https://example.com', render_js: '0' }));
  assert.throws(() => parseBee({ url: 'https://example.com', premium_proxy: 'true' }));
  assert.throws(() => parse(searchSchema, { q: 'hello', num: '' }));
  assert.throws(() => parse(searchSchema, { q: 'hello', location: 'Vancouver' }));
  assert.throws(() => parse(scrapeSchema, { url: 'https://example.com', js_scenario: {} }));
  assert.equal(parseBee({ url: 'https://example.com', extract_rules: '{"title":"h1"}' }).extract_rules.title, 'h1');
});

test('CONNECT pins the validated IP instead of resolving the hostname again', async t => {
  let captured;
  let resolveCalls = 0;
  let done;
  const connected = new Promise(resolve => { done = resolve; });
  const egress = await createEgress({
    resolve: async host => { assert.equal(host, 'public.example'); resolveCalls++; return { address: '1.1.1.1', family: 4 }; },
    connect: options => {
      captured = options;
      const socket = new net.Socket();
      queueMicrotask(() => { socket.destroy(new Error('test connection complete')); done(); });
      return socket;
    },
  });
  t.after(() => egress.close());
  const proxy = new URL(egress.url);
  const client = net.connect({ host: proxy.hostname, port: Number(proxy.port) }, () => client.write('CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n'));
  client.on('error', () => {});
  t.after(() => client.destroy());
  await connected;
  assert.deepEqual(captured, { host: '1.1.1.1', family: 4, port: 443 });
  assert.equal(resolveCalls, 1);
});

test('queue rejects overload, removes cancelled waiter, and releases capacity after failure', async () => {
  const queue = new WorkQueue(1, 1);
  let release;
  const active = queue.run(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const waiting = queue.run(() => assert.fail('cancelled job ran'), controller.signal);
  await assert.rejects(queue.run(async () => {}), { code: 'QUEUE_FULL' });
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
  release(); await active;
  await assert.rejects(queue.run(async () => { throw new Error('failure'); }), /failure/);
  assert.equal(await queue.run(async () => 42), 42);
  assert.equal(queue.active, 0);
});

test('cache is bounded and returned objects cannot mutate cached data', () => {
  const cache = new ResultCache(10000, 100);
  cache.set('a', { text: 'a'.repeat(30) });
  const value = cache.get('a'); value.text = 'mutated';
  assert.notEqual(cache.get('a').text, 'mutated');
  cache.set('b', { text: 'b'.repeat(30) });
  cache.set('c', { text: 'c'.repeat(30) });
  assert.ok(cache.bytes <= 100);
  assert.equal(cache.get('a'), undefined);
  cache.entries.get('c').expires = Date.now() - 1;
  assert.equal(cache.get('c'), undefined);
});

test('API authenticates, validates, adapts HTML/JSON/PNG, and does not leak keys', async t => {
  const key = 'test-only-key-with-more-than-24-characters';
  const calls = [];
  const scraper = { queue: { active: 0, waiting: [] },
    async scrape(options) { calls.push(options); return { url: options.url, status: 200, data: { html: '<h1>Test</h1>', screenshot: Buffer.from('png').toString('base64'), ...(options.extract_rules ? { extraction: { title: 'Test' } } : {}) }, truncated: false }; },
    async search(options) { return { search_metadata: { status: 'Success' }, organic_results: [{ position: 1, title: options.q }] }; },
  };
  const app = createApp({ scraper, apiKey: key });
  t.after(() => app.close());
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject('/v1/search?q=test')).statusCode, 401);
  const headers = { authorization: `Bearer ${key}` };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/scrape', headers, payload: { url: 'https://example.com', unknown: true } })).statusCode, 400);
  const html = await app.inject({ url: `/api/v1/?api_key=${key}&url=https://example.com&render_js=false` });
  assert.equal(html.body, '<h1>Test</h1>'); assert.equal(calls.at(-1).render_js, false);
  assert.equal(html.headers['content-security-policy'], "sandbox; default-src 'none'; frame-ancestors 'none'");
  const json = await app.inject({ url: '/api/v1?url=https://example.com&json_response=true', headers });
  assert.equal(json.json().initial_status_code, 200);
  const png = await app.inject({ url: '/api/v1?url=https://example.com&screenshot=true', headers });
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal((await app.inject({ url: '/api/v1?url=https://example.com&screenshot_full_page=true', headers })).statusCode, 400);
  const search = await app.inject({ url: '/search.json?q=hello', headers });
  assert.equal(search.json().organic_results[0].title, 'hello');
  assert.equal(search.body.includes(key), false);
});
