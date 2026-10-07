// Crawls the site from a base URL, checks the status of every link found, and checks robots.txt and sitemap.xml.
// Usage: node tools/crawl.mjs --base <url> [--max 40] [--seeds /courses,/business] [--out reports]
import { request } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, extraHeaders, sleep, USER_AGENT_SUFFIX } from './profiles.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.base) {
  console.error('usage: node tools/crawl.mjs --base <url> [--max 40] [--seeds /a,/b] [--out dir]');
  process.exit(2);
}
const BASE = new URL(args.base);
const MAX = Number(args.max || 40);
// Pacing for the site under test, so the run is not mistaken for an attack by its firewall.
const PAUSE_MS = Number(args.pause || 300);
const OUT = args.out || 'reports';
mkdirSync(OUT, { recursive: true });

const api = await request.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 ' + USER_AGENT_SUFFIX,
  extraHTTPHeaders: extraHeaders(),
  ignoreHTTPSErrors: false,
});

const norm = (href, from) => {
  try {
    const u = new URL(href, from);
    u.hash = '';
    return u.toString();
  } catch { return null; }
};
const internal = (u) => new URL(u).host === BASE.host;
const isAsset = (u) => /\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|mp4|woff2?)(\?|$)/i.test(u);

const seeds = ['/', ...(args.seeds ? args.seeds.split(',') : [])].map((s) => norm(s, BASE));
const queue = [...new Set(seeds)];
const pages = {};
const linkSources = {};

while (queue.length && Object.keys(pages).length < MAX) {
  const url = queue.shift();
  if (pages[url]) continue;
  let status = null;
  let html = '';
  let finalUrl = url;
  try {
    const r = await api.get(url, { timeout: 30000, maxRedirects: 5 });
    status = r.status();
    finalUrl = r.url();
    if ((r.headers()['content-type'] || '').includes('text/html')) html = await r.text();
  } catch (e) {
    status = `ERR ${e.message.slice(0, 80)}`;
  }
  pages[url] = { status, finalUrl };
  await sleep(PAUSE_MS);
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"/gi)) {
    const raw = m[1].replace(/&amp;/g, '&');
    if (/^(mailto:|tel:|javascript:)/i.test(raw)) continue;
    const u = norm(raw, finalUrl);
    if (!u) continue;
    (linkSources[u] ??= new Set()).add(url);
    if (internal(u) && !isAsset(u) && !pages[u] && !queue.includes(u)) queue.push(u);
  }
}

// Status for every link seen, internal and external, without crawling external sites.
const links = {};
const toCheck = Object.keys(linkSources).filter((u) => {
  if (pages[u]) { links[u] = pages[u].status; return false; }
  return true;
});
// External links: a few in parallel. Links on the site under test: one at a time, paced.
const CONCURRENCY = Number(args.concurrency || 4);
for (let i = 0; i < toCheck.length; i += CONCURRENCY) {
  await Promise.all(toCheck.slice(i, i + CONCURRENCY).map(async (u, k) => {
    if (internal(u)) await sleep(PAUSE_MS * (k + 1));
    try {
      const r = await api.get(u, { timeout: 20000, maxRedirects: 5 });
      links[u] = r.status();
    } catch (e) {
      links[u] = `ERR ${e.message.slice(0, 60)}`;
    }
  }));
}

const extra = {};
for (const p of ['/robots.txt', '/sitemap.xml']) {
  try {
    const r = await api.get(norm(p, BASE), { timeout: 20000 });
    const body = await r.text();
    extra[p] = { status: r.status(), bytes: body.length, sample: body.slice(0, 300) };
  } catch (e) {
    extra[p] = { status: `ERR ${e.message.slice(0, 60)}` };
  }
}

await api.dispose();
const broken = Object.entries(links).filter(([, s]) => typeof s !== 'number' || s >= 400)
  .map(([u, s]) => ({ url: u, status: s, foundOn: [...linkSources[u]].slice(0, 5) }));
const result = {
  base: BASE.toString(),
  pagesCrawled: Object.keys(pages).length,
  queueRemaining: queue.length,
  pages,
  linksChecked: Object.keys(links).length,
  broken,
  robotsAndSitemap: extra,
};
writeFileSync(join(OUT, 'crawl.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ ...result, pages: Object.entries(pages).map(([u, p]) => `${p.status} ${u}`) }, null, 1));
