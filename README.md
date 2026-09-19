# Patchright Scraper

A small self-hosted scraping and Google organic-search API built with **Patchright**, the patched Chromium automation library. No ScrapingBee, SerpAPI, or Firecrawl subscription is used.

It implements a documented subset of ScrapingBee and SerpAPI's public API shapes. It is independent software, not their proprietary implementation or a complete drop-in replacement.

## At a glance

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/scrape` | Render a public page and return text, Markdown, HTML, a screenshot, or CSS-selected fields |
| `GET /api/v1/` | Supported ScrapingBee-style scraping parameters |
| `GET /search.json` | Supported SerpAPI-style Google organic search parameters |
| `GET /health` | Local service health without an API key |

Each job uses isolated browser storage. The service includes API-key authentication, bounded queues and caching, and an outbound proxy that rejects private network destinations.

**Current status:** page scraping and deterministic browser fixtures passed the recorded verification. Live Google search encountered a traffic challenge, so successful Google access is not guaranteed. Docker runtime verification is still pending. See [the verification record](VERIFICATION.md).

## Run locally

Requires Node.js 22+ and macOS or Linux.

```sh
git clone https://github.com/AlexLisong/patchright-scraper.git
cd patchright-scraper
nvm use                    # if you use nvm
npm ci
npm run setup              # generates .env; installs Patchright Chromium
npm start
```

API: `http://127.0.0.1:8787`. The API key is in your ignored `.env` file. `npm run setup` does not replace an existing file or print its key.

The default opens a dedicated visible browser, separate from your normal Chrome profile. Set `HEADLESS=true` in `.env` for background execution. You can set `BROWSER_CHANNEL=chrome` to use an already installed Chrome with the Patchright driver. Neither option guarantees that a site will accept automated traffic.

For the curl examples, load the generated settings in your shell:

```sh
set -a
. ./.env
set +a
```

## Scrape a page

```sh
curl http://127.0.0.1:8787/v1/scrape \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["text","markdown","html"]}'
```

Response fields: `url`, `title`, upstream `status`, `content_type`, `data`, `truncated`, `cached`, and `elapsed_ms`. Native `/v1/scrape` returns HTTP 200 if scraping succeeded; inspect `status` for the target's HTTP status.

| Parameter | Default | Behavior |
|---|---|---|
| `url` | Required | Public HTTP(S) URL; ports 80 and 443 only |
| `formats` | `["text","html"]` | Any of `text`, `html`, `markdown`, `screenshot` |
| `render_js` | `true` | Execute page JavaScript. `false` disables it and returns original HTML; still uses Chromium. |
| `wait_for` | None | Wait for a CSS selector to attach |
| `wait` | `0` | Additional wait, 0–5000 ms |
| `timeout` | `30000` | Whole-job deadline, including queue; capped by server configuration |
| `extract_rules` | None | Named CSS selectors, up to 30 rules |
| `cache` | `true` | Use bounded in-memory cache, default five minutes |

Extraction example:

```json
{
  "url": "https://example.com",
  "formats": ["text"],
  "extract_rules": {
    "heading": "h1",
    "links": {"selector": "a", "type": "list", "output": "href"}
  }
}
```

Rule `output` may be `text`, `html`, or an attribute name. Missing single elements return `null`; lists return arrays. Extraction has a shared 250,000-character budget. `truncated` indicates a limit was reached. HTML/text/Markdown input is capped at 1.5 million characters. Screenshot output is base64 PNG of a 1365 × 900 viewport; full-page screenshots are deliberately unsupported to bound memory.

## ScrapingBee-style endpoint

Change the base URL to `http://127.0.0.1:8787/api/v1/`:

```sh
curl -G http://127.0.0.1:8787/api/v1/ \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode 'url=https://example.com' \
  --data-urlencode 'render_js=true'
```

Supports `api_key`, `url`, `render_js`, `wait`, `wait_for`, `timeout`, JSON-encoded `extract_rules`, `screenshot`, `json_response`, and `block_resources`. Booleans must be `true`/`false`. Returns HTML by default, JSON for extraction rules, or PNG for `screenshot=true`. `json_response=true` wraps the body with `resolved_url`, `initial_status_code`, `type`, and `truncated`. Target error HTTP statuses propagate for unwrapped responses. `Spb-Resolved-Url` and `Spb-Initial-Status-Code` headers are included.

Premium proxies, geography by IP, sticky sessions, custom cookies/headers, JS scenarios, full-page screenshots, and arbitrary methods are not implemented. Unsupported options return HTTP 400 instead of silently pretending to work. SDKs that attach extra options may require changes; direct HTTP clients can use this endpoint immediately.

## Google search / SerpAPI-style endpoint

```sh
curl -G http://127.0.0.1:8787/search.json \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode 'q=Patchright GitHub' \
  --data-urlencode 'num=5'
```

Aliases: `/v1/search`, `/search`, `/search.json`.

Supported: `q`, `engine=google`, `hl=en`, `gl` (two-letter country hint), `num` (1–10), `start` (0–90), `timeout`, `no_cache`, and `api_key`. `gl` is a Google search parameter, not a proxy or guarantee of physical location. Pagination/count are requests to Google; the returned page may contain fewer results. English result pages only in v0.1.

```json
{
  "search_metadata": {"status":"Success","cached":false},
  "search_parameters": {"engine":"google","q":"Patchright GitHub"},
  "organic_results": [
    {"position":1,"title":"...","link":"https://...","displayed_link":"...","snippet":"..."}
  ]
}
```

Google's web-results tab is used. Ads, Maps, Shopping, image search, rich answers, other engines, persistent sessions, and automated CAPTCHA solving are not provided. Missing snippets can be empty strings. Google HTML changes can require parser updates.

Traffic challenges return HTTP 502 / `UPSTREAM_BLOCKED`. Unknown result layouts return `PARSE_FAILED`. Neither is disguised as a successful empty result. A normal empty English search is a successful empty `organic_results` array.

## Cost and limits

- Running on an existing machine avoids an additional server bill; electricity/bandwidth still apply.
- A VPS has its own cost. This repo does not promise $1/month or parity with managed services.
- No paid proxy is included or configured. Google and protected sites may block your server IP. Patchright reduces some automation signals; it does not replace a proxy network, guarantee access, or solve challenges.
- Default concurrency is one, queue is eight, cache is 16 MiB, and a job has a 30-second deadline. Set `CONCURRENCY` (1–4), `MAX_QUEUE`, `CACHE_TTL_MS`, and `TIMEOUT_MS` if needed.
- Browsers process untrusted scripts and can consume memory before extraction. Output caps are not a hard browser-memory limit. Use the container resource limits on a dedicated host.

The service is for your own trusted callers. API keys are required, and it binds to loopback by default. Cookies/storage are isolated per job. A local outbound proxy resolves and pins every network connection to a public IP, including redirects and subresources; private, reserved, and cloud metadata destinations are rejected. Requests and API keys are not logged. Do not expose this as a public multi-tenant service without additional isolation, quotas, and operational controls.

## Run on a VPS with Docker

Copy/clone the repo onto a Linux server with Docker Compose. Set a random `API_KEY` in a local `.env`, then:

```sh
docker compose up -d --build
docker compose logs --tail=50
curl http://127.0.0.1:8787/health
```

Compose uses a non-root user, Chromium's sandbox, an Xvfb display, one CPU, a 1 GiB memory ceiling, and a Chromium-compatible seccomp profile. Start with a server that has at least 2 GiB RAM so the OS has room too. Heavy pages may need more. It binds only to the server's loopback interface. Access it through SSH without opening a public API port:

```sh
ssh -L 8787:127.0.0.1:8787 user@your-server
```

Then call `http://127.0.0.1:8787` on your laptop. A container hardening profile is included; Docker execution must be verified on the target host. No server is purchased or deployed by these files.

## Verify

```sh
npm run check
npm test
npm run test:browser    # visible real Patchright browser, deterministic fixtures
npm run smoke          # running API required; public page and live Google probe
```

Browser fixtures test JavaScript rendering, extraction, screenshot bytes, raw HTML, cookie isolation, private redirects, timeout recovery, browser restart, organic/ad parsing, challenges, and extraction budgets. Unit tests cover auth, schema/compatibility behavior, IP policy, egress denial, queue cancellation, and bounded cache.

`smoke` saves `artifacts/example.png` and exits with code 2 if live Google access is blocked. This is separate from deterministic parser-test success. See `VERIFICATION.md` for the actual results on the development machine.

## References

- [Patchright Node package](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs)
- [ScrapingBee public API documentation](https://www.scrapingbee.com/documentation/)
- [SerpAPI Google Search API](https://serpapi.com/search-api)

This project has no affiliation with those services.

## Project layout

- `src/`: API routes, request schemas, browser jobs, extraction, outbound networking, queues and cache.
- `scripts/`: local setup, syntax checks and live smoke checks.
- `test/`: API/security tests and deterministic browser fixtures.
- `deploy/`: Chromium seccomp profile and its upstream license notice.
- `.env.example`: documented local configuration; `npm run setup` creates a separate ignored `.env` with a random key.

Keep generated `.env`, browser artifacts and logs out of Git. The repository contains source and synthetic test fixtures, not a hosted scraping service.
