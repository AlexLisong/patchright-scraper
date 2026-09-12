import { z } from 'zod';
import { ApiError } from './errors.mjs';

const bool = z.preprocess(v => v === 'true' ? true : v === 'false' ? false : v, z.boolean());
const int = (min, max) => z.preprocess(v => typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v, z.number().int().min(min).max(max));
const rule = z.union([
  z.string().min(1).max(500),
  z.object({ selector: z.string().min(1).max(500), type: z.enum(['item', 'list']).default('item'), output: z.string().min(1).max(100).default('text') }).strict(),
]);
export const scrapeSchema = z.object({
  url: z.string().min(1).max(4096),
  render_js: bool.default(true),
  formats: z.array(z.enum(['html', 'text', 'markdown', 'screenshot'])).min(1).max(4).default(['text', 'html']),
  wait: int(0, 5000).default(0),
  wait_for: z.string().min(1).max(500).optional(),
  timeout: int(1000, 60000).default(30000),
  extract_rules: z.record(z.string().max(100), rule).refine(r => Object.keys(r).length <= 30).optional(),
  cache: bool.default(true),
}).strict();
const beeSchema = scrapeSchema.omit({ formats: true, cache: true }).extend({
  api_key: z.string().optional(), json_response: bool.default(false),
  screenshot: bool.default(false), screenshot_full_page: bool.default(false),
  block_resources: bool.default(true),
}).strict();
export const searchSchema = z.object({
  api_key: z.string().optional(), engine: z.literal('google').default('google'),
  q: z.string().trim().min(1).max(1000),
  hl: z.literal('en').default('en'),
  gl: z.string().regex(/^[a-z]{2}$/).default('us'),
  num: int(1, 10).default(10), start: int(0, 90).default(0),
  no_cache: bool.default(false), timeout: int(1000, 60000).default(30000),
}).strict();

export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError('INVALID_REQUEST', result.error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '));
  return result.data;
}
export function parseBee(query) {
  const input = { ...query };
  if (typeof input.extract_rules === 'string') {
    try { input.extract_rules = JSON.parse(input.extract_rules); }
    catch { throw new ApiError('INVALID_REQUEST', 'extract_rules must be valid JSON.'); }
  }
  return parse(beeSchema, input);
}
