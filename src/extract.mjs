// Runs inside the page. Keep this function self-contained.
export function extractDocument({ rules, maxChars = 1500000 }) {
  const extraction = {};
  let remaining = 250000;
  let extractionTruncated = false;
  const bounded = value => {
    if (value === null) return null;
    const text = String(value);
    const out = text.slice(0, remaining);
    extractionTruncated ||= out.length < text.length;
    remaining -= out.length;
    return out;
  };
  for (const [name, rule] of Object.entries(rules || {})) {
    const { selector, type = 'item', output = 'text' } = typeof rule === 'string' ? { selector: rule } : rule;
    const read = el => bounded(output === 'text' ? (el.innerText || el.textContent || '').trim()
      : output === 'html' ? el.innerHTML : el.getAttribute(output));
    if (type === 'list') {
      extraction[name] = [];
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (remaining <= 0 || extraction[name].length >= 1000) { extractionTruncated = true; break; }
        extraction[name].push(read(el));
      }
    }
    else { const el = document.querySelector(selector); extraction[name] = el ? read(el) : null; }
  }
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,svg,template').forEach(el => el.remove());
  const text = (document.body?.innerText || '').slice(0, maxChars);
  const html = document.documentElement.outerHTML;
  return {
    title: document.title.slice(0, 2000), text, html: html.slice(0, maxChars),
    cleanHtml: clone.outerHTML.slice(0, maxChars), extraction,
    truncated: extractionTruncated || html.length > maxChars || (document.body?.innerText.length || 0) > maxChars,
  };
}

export function extractGoogle({ start = 0, num = 10 }) {
  const body = document.body?.innerText || '';
  const hostname = location.hostname;
  if (hostname.startsWith('consent.') || document.querySelector('form[action*="consent.google"]')) return { blocked: 'Google requires consent.' };
  if (location.pathname.startsWith('/sorry') || document.querySelector('#captcha-form, iframe[src*="recaptcha"], .g-recaptcha') || (!document.querySelector('#search h3, #rso h3, #main h3') && /our systems have detected unusual traffic|automated queries/i.test(body))) return { blocked: 'Google returned a traffic challenge.' };
  const seen = new Set();
  const results = [];
  for (const heading of document.querySelectorAll('#search h3, #rso h3, #main h3')) {
    const anchor = heading.closest('a') || heading.parentElement?.closest('a');
    if (!anchor) continue;
    if (anchor.closest('[data-text-ad], [data-ta-slot]')) continue;
    let link;
    try {
      let parsed = new URL(anchor.href, location.href);
      if (parsed.pathname === '/url' && /(^|\.)google\./.test(parsed.hostname)) parsed = new URL(parsed.searchParams.get('q') || parsed.searchParams.get('url'));
      if (!['http:', 'https:'].includes(parsed.protocol) || /(^|\.)google\./.test(parsed.hostname)) continue;
      link = parsed.href;
    } catch { continue; }
    if (seen.has(link)) continue;
    let card = anchor.parentElement;
    while (card?.parentElement && card.parentElement.querySelectorAll('h3').length === 1 && card.parentElement.id !== 'search' && card.parentElement.id !== 'rso') card = card.parentElement;
    if (card?.closest('[data-text-ad], [data-ta-slot]')) continue;
    const snippet = card?.querySelector('.VwiC3b, .IsZvec, .aCOpRe, [data-sncf], .yXK7lf, .s3v9rd')?.textContent?.trim() || '';
    const title = heading.textContent?.trim();
    if (!title) continue;
    seen.add(link);
    results.push({ position: start + results.length + 1, title, link, displayed_link: card?.querySelector('cite')?.textContent?.trim() || new URL(link).hostname, snippet });
    if (results.length >= num) break;
  }
  return { organic_results: results, noResults: /did not match any documents|no results found for/i.test(body) };
}
