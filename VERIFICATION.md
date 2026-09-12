# Verification — September 12, 2026

Development host: macOS, Node 22.23.1, Patchright 1.63.0.

| Check | Result |
|---|---|
| `npm run check` | Passed |
| `npm test` | 7 test groups passed |
| `npm run test:browser` | Passed using a visible real Patchright browser |
| `npm audit --omit=dev` | 0 reported vulnerabilities |
| `docker compose config --quiet` | Passed |
| Live `https://example.com` scrape through `/v1/scrape` | HTTP 200, correct title/text/Markdown, valid PNG; approximately 0.8 s on this host |
| API authentication without a key | HTTP 401 |
| Cloud metadata destination | HTTP 403 |
| Live Google search through `/search.json` | HTTP 502 / `UPSTREAM_BLOCKED`; Google presented a traffic challenge |
| Google parser fixtures | Organic ranking/snippets, ad exclusion, challenge and consent detection passed |
| Chrome alternatives | Installed Chrome and a temporary persistent Chrome profile also received a Google challenge |
| Docker image/container runtime | Not run: local Docker daemon is unavailable |

Code and security reviews identified extraction amplification, special IP ranges, ad classification, and challenge-text false positives; fixes and relevant regression checks passed. Search is explicitly limited to English result pages in v0.1.

The live Google result is a real limitation: the implementation has not demonstrated successful Google search access from this host. A different permitted network/proxy arrangement may be necessary. Parser fixtures are not evidence of live Google availability.

No cloud host or proxy was purchased. No existing paid subscriptions were changed. The included Docker setup still needs runtime verification on the deployment host.
