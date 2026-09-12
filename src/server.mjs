import { Scraper } from './scraper.mjs';
import { createApp } from './app.mjs';

const integer = (name, fallback, min, max) => {
  const number = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return number;
};
if (process.env.HEADLESS && !['true', 'false'].includes(process.env.HEADLESS)) throw new Error('HEADLESS must be true or false.');
if (!process.env.API_KEY || process.env.API_KEY.length < 24 || process.env.API_KEY.startsWith('replace-with')) throw new Error('Run npm run setup or configure a random API_KEY of at least 24 characters.');
const scraper = await new Scraper({
  headless: process.env.HEADLESS === 'true', channel: process.env.BROWSER_CHANNEL,
  concurrency: integer('CONCURRENCY', 1, 1, 4), maxQueue: integer('MAX_QUEUE', 8, 0, 50),
  timeout: integer('TIMEOUT_MS', 30000, 1000, 60000), cacheTtl: integer('CACHE_TTL_MS', 300000, 0, 3600000),
}).start();
const app = createApp({ scraper, apiKey: process.env.API_KEY, logger: true });
app.addHook('onClose', async () => scraper.close());
for (const event of ['SIGTERM', 'SIGINT']) process.once(event, async () => { await app.close(); process.exit(0); });
try { await app.listen({ host: process.env.HOST || '127.0.0.1', port: integer('PORT', 8787, 1, 65535) }); }
catch (error) { app.log.error({ message: error.message }, 'Startup failed'); await app.close(); process.exitCode = 1; }
