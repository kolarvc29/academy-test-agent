// Device profiles the agent tests on. Keep names in sync with the prompt's <devices> block.
import { devices } from 'playwright';

export const PROFILES = {
  'desktop-chromium': { browser: 'chromium', context: { viewport: { width: 1440, height: 900 } } },
  'desktop-webkit': { browser: 'webkit', context: { viewport: { width: 1440, height: 900 } } },
  'iphone-webkit': { browser: 'webkit', context: { ...devices['iPhone 14'] } },
  'pixel-chromium': { browser: 'chromium', context: { ...devices['Pixel 7'] } },
  'tablet-chromium': { browser: 'chromium', context: { viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true } },
};

export const MOBILE = new Set(['iphone-webkit', 'pixel-chromium', 'tablet-chromium']);

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    }
  }
  return out;
}

export function slug(url) {
  const u = new URL(url);
  return (u.pathname.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'home').slice(0, 80);
}

// Vercel "Protection Bypass for Automation": lets pipeline runs through deployment protection
// and firewall challenges. Set VERCEL_AUTOMATION_BYPASS_SECRET in the environment; never commit it.
export function extraHeaders() {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return secret ? { 'x-vercel-protection-bypass': secret, 'x-vercel-set-bypass-cookie': 'true' } : {};
}

export const USER_AGENT_SUFFIX = 'YalloAcademyTestAgent';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
