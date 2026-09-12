import { chromium } from 'patchright';
import TurndownService from 'turndown';
import { randomUUID } from 'node:crypto';
import { createEgress, resolvePublic, targetUrl } from './egress.mjs';
import { WorkQueue, ResultCache } from './resources.mjs';
import { ApiError } from './errors.mjs';
import { extractDocument, extractGoogle } from './extract.mjs';

export class Scraper {
  browserPromise;
  closed = false;
  constructor(config = {}, dependencies = {}) {
    this.config = { headless: false, concurrency: 1, maxQueue: 8, timeout: 30000, cacheTtl: 300000, ...config };
    this.queue = new WorkQueue(this.config.concurrency, this.config.maxQueue);
    this.cache = new ResultCache(this.config.cacheTtl);
    this.validate = dependencies.validate || targetUrl;
    this.resolve = dependencies.resolve || resolvePublic;
    this.createEgress = dependencies.createEgress || createEgress;
    this.markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  }
  async start() {
    this.egress = await this.createEgress();
    return this;
  }
  async browser() {
    if (this.closed) throw new ApiError('UNAVAILABLE', 'Scraper is shutting down.', 503);
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({
        headless: this.config.headless,
        channel: this.config.channel || undefined,
        chromiumSandbox: process.platform === 'linux',
        proxy: { server: this.egress.url, bypass: '<-loopback>' },
        args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        timeout: 20000,
      }).then(browser => {
        browser.on('disconnected', () => { this.browserPromise = undefined; });
        return browser;
      }).catch(error => { this.browserPromise = undefined; throw error; });
    }
    return this.browserPromise;
  }
  async withPage(options, work, clientSignal) {
    const timeout = Math.min(options.timeout, this.config.timeout);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ApiError('TIMEOUT', `Request exceeded ${timeout} ms.`, 504)), timeout);
    const signal = clientSignal ? AbortSignal.any([controller.signal, clientSignal]) : controller.signal;
    try {
      return await this.queue.run(async () => {
        let context;
        let aborted;
        const abort = () => { aborted?.(signal.reason); if (context) void context.close().catch(() => {}); };
        const cancelled = new Promise((_resolve, reject) => { aborted = reject; signal.addEventListener('abort', abort, { once: true }); });
        const operation = async () => {
          const url = this.validate(options.url);
          await this.resolve(url.hostname);
          signal.throwIfAborted();
          const browser = await this.browser();
          signal.throwIfAborted();
          context = await browser.newContext({ javaScriptEnabled: options.render_js, serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1365, height: 900 } });
          if (signal.aborted) { await context.close(); signal.throwIfAborted(); }
          let blockedNavigation = false;
          let responseTooLarge = false;
          context.on('page', page => { if (context.pages().length > 1) void page.close().catch(() => {}); });
          await context.route('**/*', async route => {
            try {
              const request = route.request();
              this.validate(request.url());
              // Connection-time egress pinning is authoritative; this check also
              // supplies useful errors for blocked top-level redirects.
              if (request.isNavigationRequest()) await this.resolve(new URL(request.url()).hostname);
              if (options.block_resources !== false && !options.formats.includes('screenshot') && ['image', 'media', 'font'].includes(request.resourceType())) return await route.abort();
              await route.continue();
            } catch {
              if (route.request().isNavigationRequest() && route.request().frame() === context.pages()[0]?.mainFrame()) blockedNavigation = true;
              await route.abort().catch(() => {});
            }
          });
          const page = await context.newPage();
          page.setDefaultTimeout(timeout);
          page.on('response', response => {
            if (response.request().isNavigationRequest() && Number(response.headers()['content-length']) > 8 * 1024 * 1024) {
              responseTooLarge = true;
              void page.close().catch(() => {});
            }
          });
          try {
            const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout });
            await this.resolve(this.validate(page.url()).hostname);
            if (options.wait_for) await page.locator(options.wait_for).first().waitFor({ state: 'attached', timeout });
            if (options.wait) await new Promise(resolveWait => setTimeout(resolveWait, options.wait));
            signal.throwIfAborted();
            return await work(page, response);
          } catch (error) {
            if (responseTooLarge) throw new ApiError('RESPONSE_TOO_LARGE', 'Target document exceeds 8 MiB.', 502);
            if (blockedNavigation) throw new ApiError('TARGET_BLOCKED', 'Navigation to a non-public destination was blocked.', 403);
            throw error;
          }
        };
        try { return await Promise.race([operation(), cancelled]); }
        finally {
          signal.removeEventListener('abort', abort);
          if (context) await context.close().catch(() => {});
        }
      }, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ApiError) throw error;
      if (error.name === 'TimeoutError') throw new ApiError('TIMEOUT', 'The target did not finish within the request timeout.', 504);
      throw new ApiError('UPSTREAM_ERROR', 'Browser request failed. Check the target, browser installation, or server logs.', 502);
    } finally { clearTimeout(timer); }
  }
  async scrape(options, signal) {
    const key = JSON.stringify(['scrape', options]);
    const cached = options.cache && this.cache.get(key);
    if (cached) return { ...cached, cached: true };
    const started = Date.now();
    const result = await this.withPage(options, async (page, response) => {
      let doc;
      try { doc = await page.evaluate(extractDocument, { rules: options.extract_rules }); }
      catch { throw new ApiError('EXTRACTION_FAILED', 'Extraction failed. Check your CSS selectors and target document.', 422); }
      const data = {};
      for (const format of options.formats) {
        if (format === 'markdown') data.markdown = this.markdown.turndown(doc.cleanHtml);
        else if (format === 'screenshot') {
          // A bounded viewport screenshot prevents enormous pages exhausting memory.
          const bytes = await page.screenshot({ type: 'png', fullPage: false, timeout: options.timeout });
          data.screenshot = bytes.toString('base64');
        } else if (format === 'html' && !options.render_js) {
          const raw = await response.body();
          if (raw.length > 8 * 1024 * 1024) throw new ApiError('RESPONSE_TOO_LARGE', 'Target document exceeds 8 MiB.', 502);
          data.html = raw.toString('utf8').slice(0, 1500000);
          doc.truncated ||= raw.length > 1500000;
        } else data[format] = doc[format];
      }
      if (options.extract_rules) data.extraction = doc.extraction;
      const result = { url: page.url(), title: doc.title, status: response?.status() || 200, content_type: response?.headers()['content-type'] || '', data, truncated: doc.truncated, cached: false, elapsed_ms: Date.now() - started };
      if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new ApiError('RESPONSE_TOO_LARGE', 'Extracted response exceeds 8 MiB.', 502);
      return result;
    }, signal);
    if (options.cache && result.status < 400) this.cache.set(key, result);
    return result;
  }
  async search(options, signal) {
    const { api_key: _apiKey, no_cache, ...parameters } = options;
    const key = JSON.stringify(['search', parameters]);
    const cached = !no_cache && this.cache.get(key);
    if (cached) { cached.search_metadata.cached = true; return cached; }
    const url = new URL('https://www.google.com/search');
    for (const key of ['q', 'hl', 'gl', 'num', 'start']) url.searchParams.set(key, String(parameters[key]));
    url.searchParams.set('udm', '14');
    const started = Date.now();
    const result = await this.withPage({ url: url.href, render_js: true, formats: ['html'], timeout: options.timeout }, async (page, response) => {
      await page.waitForFunction(() => document.querySelector('#search h3, #rso h3, #main h3, #captcha-form, form[action*="consent.google"]') || /unusual traffic|automated queries|did not match any documents|no results found for/i.test(document.body?.innerText || '') || location.hostname.startsWith('consent.') || location.pathname.startsWith('/sorry'), null, { timeout: Math.min(8000, options.timeout) }).catch(error => { if (error.name !== 'TimeoutError') throw error; });
      const extracted = await page.evaluate(extractGoogle, { start: options.start, num: options.num });
      if (extracted.blocked) throw new ApiError('UPSTREAM_BLOCKED', extracted.blocked, 502);
      if ((response?.status() || 200) >= 400) throw new ApiError('UPSTREAM_ERROR', `Google returned HTTP ${response.status()}.`, 502);
      if (!extracted.organic_results.length && !extracted.noResults) throw new ApiError('PARSE_FAILED', 'Google returned an unrecognized page. It may be a challenge or a changed result layout.', 502);
      return {
        search_metadata: { id: randomUUID(), status: 'Success', created_at: new Date(started).toISOString(), processed_at: new Date().toISOString(), google_url: url.href, total_time_taken: (Date.now() - started) / 1000, cached: false },
        search_parameters: parameters,
        organic_results: extracted.organic_results,
      };
    }, signal);
    if (!no_cache) this.cache.set(key, result);
    return result;
  }
  async close() {
    this.closed = true;
    const browser = await this.browserPromise?.catch(() => undefined);
    if (browser) await browser.close();
    await this.egress?.close();
  }
}
