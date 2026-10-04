// Responsive check for the Live screen: load the app at phone, tablet and
// desktop widths and fail when the page scrolls sideways or a panel body
// overflows its panel. Reports the three columns' heights so imbalance is
// visible. Needs the dev harness (app/server/harness.tmp.mts + vite) or any
// running app; pass its origin and, for the harness, its session cookie.
//
//   node scripts/responsive-check.mjs [origin] [cookie]
//   CHROME_PATH=/path/to/chrome node scripts/responsive-check.mjs http://localhost:5174 harness-session
//
// playwright-core is resolved from PLAYWRIGHT_CORE when it is not installed here.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const origin = process.argv[2] ?? 'http://localhost:5174';
const cookie = process.argv[3] ?? 'harness-session';
const widths = (process.env.WIDTHS ?? '360,390,600,768,1024,1280,1366,1536,1920').split(',').map(Number);

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE, 'playwright-core', ...readdirSync(join(homedir(), '.npm/_npx'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(homedir(), '.npm/_npx', d.name, 'node_modules/playwright-core'))].filter(Boolean);
  const req = createRequire(import.meta.url);
  for (const c of candidates) { try { return req(c); } catch { /* next */ } }
  throw new Error('playwright-core not found: npm i -D playwright-core, or set PLAYWRIGHT_CORE to an installed copy');
}
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.BROWSER;
  const root = join(homedir(), '.cache/ms-playwright');
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse() : [];
  for (const d of dirs) for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) { const p = join(root, d, sub); if (existsSync(p)) return p; }
  return undefined;
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const host = new URL(origin).hostname;
await ctx.addCookies([{ name: '__Host-desk_session', value: cookie, domain: host, path: '/', secure: true, sameSite: 'Lax' }]);
const page = await ctx.newPage();
await page.goto(origin, { waitUntil: 'networkidle' });
// The app opens on Strategy; the column checks below are the Live screen's.
await page.locator('nav.tabs button', { hasText: 'Live' }).click();
await page.waitForSelector('.ov-main', { timeout: 30_000 });
// Every panel open: a folded panel hides the tables the check is about.
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('btc-desk:live:fold:')) localStorage.removeItem(k); });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.ov-main');

let failures = 0;
for (const w of widths) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflowX = doc.scrollWidth - doc.clientWidth;
    // Panels whose body is wider than the panel: their tables must scroll inside, never spill.
    const spills = [...document.querySelectorAll('.ov-panel')].filter((p) => p.scrollWidth > p.clientWidth + 1).map((p) => p.querySelector('h3')?.textContent ?? '?');
    const cols = [...document.querySelectorAll('.ov-main > *')].map((c) => Math.round(c.getBoundingClientRect().height));
    const panels = document.querySelectorAll('.ov-panel').length;
    const folds = document.querySelectorAll('.ov-fold').length;
    const stacked = getComputedStyle(document.querySelector('.ov-main')).gridTemplateColumns.split(' ').length;
    return { overflowX, spills, cols, panels, folds, stacked };
  });
  const bad = r.overflowX > 0 || r.spills.length > 0 || r.folds !== r.panels;
  if (bad) failures++;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${String(w).padStart(4)}px  columns=${r.stacked} heights=${r.cols.join('/')} panels=${r.panels} folds=${r.folds}` + (r.overflowX > 0 ? `  page overflows by ${r.overflowX}px` : '') + (r.spills.length ? `  spills: ${r.spills.join(', ')}` : ''));
}
// Every screen, at phone, tablet, laptop and desktop widths: the page must not scroll sideways, and nothing
// outside a scroller of its own may reach past the edge. (The Live screen's Collapse-all step went with its button.)
const SCREEN_WIDTHS = (process.env.SCREEN_WIDTHS ?? '360,390,768,1024,1366,1920').split(',').map(Number);
const tabs = page.locator('nav.tabs button');
const names = await tabs.allTextContents();
for (const [i, raw] of names.entries()) {
  const name = raw.replace(/\s+/g, ' ').trim() || `screen ${i + 1}`;
  const rows = [];
  for (const w of SCREEN_WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await tabs.nth(i).scrollIntoViewIfNeeded();
    await tabs.nth(i).click();
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
      const vw = window.innerWidth;
      const scrolls = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
      const past = [];
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.right > vw + 1 && !scrolls(el)) past.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} +${Math.round(b.right - vw)}px`);
      }
      return { overflowX: document.documentElement.scrollWidth - vw, past: past.slice(0, 3) };
    });
    const bad = r.overflowX > 0 || r.past.length > 0;
    if (bad) failures++;
    rows.push(`${w}${bad ? ` FAIL(${r.overflowX > 0 ? `page +${r.overflowX}px` : r.past.join('; ')})` : ''}`);
  }
  console.log(`${rows.some((x) => x.includes('FAIL')) ? 'FAIL' : 'ok  '} ${name.padEnd(12)} ${rows.join('  ')}`);
}
await browser.close();
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all widths pass');
