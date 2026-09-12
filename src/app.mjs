import Fastify, { LogController } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parse, scrapeSchema, searchSchema, parseBee } from './contracts.mjs';
import { ApiError } from './errors.mjs';

export function createApp({ scraper, apiKey, logger = false }) {
  if (!apiKey || apiKey.length < 24) throw new Error('Set API_KEY to a random secret of at least 24 characters. Run npm run setup.');
  const hash = value => createHash('sha256').update(value).digest();
  const expected = hash(apiKey);
  const app = Fastify({ logger, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 32768, requestTimeout: 65000, connectionTimeout: 70000 });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
    if (request.url.split('?')[0] === '/health') return;
    const provided = request.headers.authorization?.replace(/^Bearer /i, '') || request.query?.api_key || request.headers['x-api-key'];
    if (typeof provided !== 'string' || !timingSafeEqual(hash(provided), expected)) throw new ApiError('UNAUTHORIZED', 'Provide your API key via Bearer token, X-API-Key, or api_key.', 401);
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    const code = error.code?.startsWith('FST_') ? 'INVALID_REQUEST' : error.code || 'INTERNAL_ERROR';
    // Never log query strings, scraped bodies, or request headers: these can contain secrets.
    if (status >= 500) request.log.error({ code, status, requestId: request.id }, 'Scraper request failed');
    if (status === 429) reply.header('Retry-After', '5');
    reply.code(status).send({ error: status === 500 ? 'Internal service error.' : error.message, code, ...(request.url.startsWith('/search') ? { search_metadata: { status: 'Error' } } : {}) });
  });
  const run = async (request, reply, fn) => {
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(new ApiError('CANCELLED', 'Client disconnected.', 499)); };
    reply.raw.on('close', abort);
    try { return await fn(controller.signal); }
    finally { reply.raw.removeListener('close', abort); }
  };
  app.get('/health', async () => ({ status: 'ok', engine: 'patchright', active: scraper.queue.active, queued: scraper.queue.waiting.length }));
  app.get('/', async () => ({ name: 'Patchright Scraper', version: '0.1.0', endpoints: ['POST /v1/scrape', 'GET /v1/search', 'GET /api/v1/', 'GET /search.json'], scope: 'Public pages and Google organic results. See README for supported parameters.' }));
  app.post('/v1/scrape', async (request, reply) => {
    const options = parse(scrapeSchema, request.body);
    return run(request, reply, signal => scraper.scrape(options, signal));
  });
  const search = async (request, reply) => {
    const options = parse(searchSchema, request.query);
    return run(request, reply, signal => scraper.search(options, signal));
  };
  app.get('/v1/search', search);
  app.get('/search.json', search);
  app.get('/search', search);
  const bee = async (request, reply) => {
    const options = parseBee(request.query);
    if (options.screenshot_full_page) throw new ApiError('UNSUPPORTED_OPTION', 'Full-page screenshots are not supported; use screenshot=true for a bounded viewport screenshot.');
    const formats = options.screenshot ? ['screenshot'] : ['html'];
    const { api_key: _key, json_response, screenshot: _screenshot, screenshot_full_page: _full, ...rest } = options;
    const result = await run(request, reply, signal => scraper.scrape({ ...rest, formats, cache: false }, signal));
    reply.header('Spb-Resolved-Url', result.url).header('Spb-Initial-Status-Code', result.status);
    if (json_response) return { body: result.data.extraction || result.data.screenshot || result.data.html, resolved_url: result.url, initial_status_code: result.status, type: options.screenshot ? 'screenshot' : options.extract_rules ? 'json' : 'html', truncated: result.truncated };
    if (result.status >= 400) reply.code(result.status);
    if (options.extract_rules) return result.data.extraction;
    if (options.screenshot) return reply.type('image/png').send(Buffer.from(result.data.screenshot, 'base64'));
    return reply.header('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'").type('text/html; charset=utf-8').send(result.data.html);
  };
  app.get('/api/v1', bee);
  app.get('/api/v1/', bee);
  return app;
}
