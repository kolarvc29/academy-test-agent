// Audits one URL on one or more device profiles and prints a JSON evidence pack.
// Usage: node tools/audit.mjs --url <url> [--profiles all|a,b] [--out reports]
// The agent reads this evidence and decides what is a defect; this tool never judges severity.
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES, MOBILE, parseArgs, slug, extraHeaders } from './profiles.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.url) {
  console.error('usage: node tools/audit.mjs --url <url> [--profiles all|name,name] [--out dir]');
  process.exit(2);
}
const OUT = args.out || 'reports';
const names = !args.profiles || args.profiles === 'all' ? Object.keys(PROFILES) : args.profiles.split(',');
mkdirSync(join(OUT, 'screens'), { recursive: true });

// Collected in the page before any script runs, so LCP and CLS are not missed.
const VITALS = () => {
  window.__vitals = { lcp: 0, cls: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__vitals.lcp = e.startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__vitals.cls += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
  } catch { /* WebKit lacks some entry types; reported as null */ }
};

const engines = { chromium, webkit };
const browsers = {};
const results = [];

for (const name of names) {
  const prof = PROFILES[name];
  if (!prof) { results.push({ profile: name, error: 'unknown profile' }); continue; }
  browsers[prof.browser] ??= await engines[prof.browser].launch();
  const ctx = await browsers[prof.browser].newContext({ ...prof.context, extraHTTPHeaders: extraHeaders() });
  await ctx.addInitScript(VITALS);
  const page = await ctx.newPage();
  const consoleMsgs = [];
  const failed = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => consoleMsgs.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (/[?&]_rsc=/.test(u)) return; // Next.js prefetch aborts are benign
    failed.push(`${r.failure()?.errorText} ${u.slice(0, 200)}`);
  });
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 200)}`); });

  const t0 = Date.now();
  let status = null;
  let finalUrl = null;
  let navError = null;
  try {
    const resp = await page.goto(args.url, { waitUntil: 'networkidle', timeout: 60000 });
    status = resp?.status() ?? null;
    finalUrl = page.url();
  } catch (e) {
    navError = e.message.slice(0, 200);
  }
  const loadMs = Date.now() - t0;

  if (navError) {
    results.push({ profile: name, url: args.url, navError, loadMs, consoleMsgs, failed });
    await ctx.close();
    continue;
  }

  // Scroll to trigger lazy content, then return to the top.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 100)); }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);

  const info = await page.evaluate((isMobile) => {
    const q = (s) => document.querySelector(s);
    const meta = (n) => q(`meta[name="${n}"]`)?.content ?? q(`meta[property="${n}"]`)?.content ?? null;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
    };
    const sel = (el) => {
      if (el.id) return `#${el.id}`;
      const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `${el.tagName.toLowerCase()}${cls}`;
    };
    const text = document.body.innerText;

    // Text leaves: elements that own visible text directly.
    const leaves = [...document.querySelectorAll('body *')].filter((el) =>
      visible(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2));
    const rects = leaves.slice(0, 1500).map((el) => ({ el, r: el.getBoundingClientRect() }));
    const overlaps = [];
    for (let i = 0; i < rects.length && overlaps.length < 15; i++) {
      for (let j = i + 1; j < rects.length && overlaps.length < 15; j++) {
        const a = rects[i];
        const b = rects[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w <= 2 || h <= 2) continue;
        const area = w * h;
        const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
        if (area / smaller > 0.3) {
          overlaps.push({
            a: sel(a.el), aText: a.el.textContent.trim().slice(0, 60),
            b: sel(b.el), bText: b.el.textContent.trim().slice(0, 60),
            y: Math.round(a.r.top + window.scrollY),
          });
        }
      }
    }

    // Text blocks a screen reader would hear twice (not hidden from assistive tech).
    const seen = new Map();
    for (const el of leaves) {
      if (el.closest('[aria-hidden="true"]')) continue;
      const t = el.textContent.trim();
      if (t.length < 25) continue;
      seen.set(t, (seen.get(t) || 0) + 1);
    }
    const duplicatedText = [...seen.entries()].filter(([, n]) => n > 1).slice(0, 15).map(([t, n]) => ({ text: t.slice(0, 80), count: n }));

    // Brand: "Yallo" rendered in capitals via CSS, literal YALLO, em dashes.
    const brandUppercase = leaves.filter((el) => /yallo/i.test(el.textContent) && getComputedStyle(el).textTransform === 'uppercase')
      .slice(0, 10).map((el) => ({ selector: sel(el), text: el.textContent.trim().slice(0, 60) }));
    const emDashSamples = (text.match(/.{0,40}—.{0,40}/g) || []).slice(0, 10);

    const small = isMobile ? [...document.querySelectorAll('a, button, input, select, [role=button]')]
      .filter((el) => visible(el)).map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width < 44 || r.height < 44).slice(0, 15)
      .map(({ el, r }) => ({ selector: sel(el), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) })) : [];

    const links = [...document.querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), abs: a.href, text: (a.textContent || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60) }));
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource');

    return {
      title: document.title,
      lang: document.documentElement.lang || null,
      description: meta('description'),
      canonical: q('link[rel=canonical]')?.href ?? null,
      robots: meta('robots'),
      og: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image'), url: meta('og:url') },
      twitter: { card: meta('twitter:card'), title: meta('twitter:title'), image: meta('twitter:image') },
      h1: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim().slice(0, 100)),
      headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => `${h.tagName} ${h.textContent.trim().replace(/\s+/g, ' ').slice(0, 90)}`).slice(0, 80),
      imagesNoAlt: [...document.images].filter((i) => !i.hasAttribute('alt')).map((i) => i.src.slice(0, 150)).slice(0, 20),
      imagesBroken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src.slice(0, 150)).slice(0, 20),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      pageHeight: document.body.scrollHeight,
      overlaps,
      duplicatedText,
      brandUppercase,
      literalYALLO: (text.match(/YALLO/g) || []).length,
      emDashCount: (text.match(/—/g) || []).length,
      emDashSamples,
      smallTouchTargets: small,
      deadLinks: links.filter((l) => !l.href || l.href === '#' || l.href.startsWith('javascript')).slice(0, 20),
      links,
      vitals: { lcpMs: window.__vitals?.lcp ? Math.round(window.__vitals.lcp) : null, cls: window.__vitals ? Number(window.__vitals.cls.toFixed(3)) : null },
      transferKb: Math.round(((nav?.transferSize || 0) + res.reduce((s, r) => s + (r.transferSize || 0), 0)) / 1024),
      requests: res.length + 1,
      textSample: text.slice(0, 4000),
    };
  }, MOBILE.has(name));

  let axe = null;
  try {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    axe = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
      .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }));
  } catch (e) {
    axe = { error: e.message.slice(0, 200) };
  }

  const shot = join(OUT, 'screens', `${slug(args.url)}--${name}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => null);
  results.push({ profile: name, url: args.url, status, finalUrl, loadMs, consoleMsgs, failed, axe, screenshot: shot, ...info });
  await ctx.close();
}

for (const b of Object.values(browsers)) await b.close();
const file = join(OUT, `audit--${slug(args.url)}.json`);
writeFileSync(file, JSON.stringify(results, null, 1));
// Print a compact view; links and textSample stay in the file to keep agent context small.
console.log(JSON.stringify(results.map(({ links, textSample, ...rest }) => ({ ...rest, linkCount: links?.length })), null, 1));
console.error(`full evidence: ${file}`);
