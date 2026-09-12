import { ApiError } from './errors.mjs';

export class WorkQueue {
  active = 0;
  waiting = [];
  constructor(concurrency = 1, maxQueue = 8) { this.concurrency = concurrency; this.maxQueue = maxQueue; }
  async run(work, signal) {
    signal?.throwIfAborted();
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxQueue) throw new ApiError('QUEUE_FULL', 'Scraper is busy; retry later.', 429);
      await new Promise((resolve, reject) => {
        const entry = { resolve: () => { cleanup(); resolve(); } };
        const abort = () => {
          this.waiting = this.waiting.filter(item => item !== entry);
          cleanup(); reject(signal.reason);
        };
        const cleanup = () => signal?.removeEventListener('abort', abort);
        signal?.addEventListener('abort', abort, { once: true });
        this.waiting.push(entry);
      });
    } else { this.active++; }
    try { signal?.throwIfAborted(); return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next.resolve(); else this.active--;
    }
  }
}

export class ResultCache {
  entries = new Map();
  bytes = 0;
  constructor(ttl = 300000, limit = 16 * 1024 * 1024) { this.ttl = ttl; this.limit = limit; }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires < Date.now()) { this.delete(key); return; }
    return structuredClone(entry.value);
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.size;
    this.entries.delete(key);
  }
  set(key, value) {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (!this.ttl || size > this.limit / 2) return;
    this.delete(key);
    while (this.bytes + size > this.limit) this.delete(this.entries.keys().next().value);
    this.entries.set(key, { value: structuredClone(value), size, expires: Date.now() + this.ttl });
    this.bytes += size;
  }
}
