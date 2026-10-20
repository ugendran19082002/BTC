import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Light and dark, one design (owner, 20 Oct 2026). Two guards on what the eye cannot check every time a colour moves:
 * every colour that is read is readable on the panels, in both themes; and the screens use the tokens, not colours of
 * their own -- four greens and four reds had grown, and none of them knew there was a light theme.
 */
const SRC = join(__dirname, '..');
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(at, css.indexOf('\n}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*--([a-z0-9-]+):\s*([^;]+);/gm)) out[m[1]!] = m[2]!.trim();
  return out;
}
const dark = block(':root');
const light = { ...dark, ...block(":root[data-theme='light']") };
const resolve = (t: Record<string, string>, v: string, depth = 0): string => {
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(v);
  return ref && depth < 5 ? resolve(t, t[ref[1]!]!, depth + 1) : v;
};
const lum = (hex: string) => {
  const n = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!n) throw new Error(`not a plain colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

/** What is read, and how much it must stand out: 4.5:1 for words and numbers, 3:1 for a label never to be read closely. */
const READ: [string, number][] = [['text', 4.5], ['muted', 4.5], ['up', 4.5], ['down', 4.5], ['warn', 4.5], ['accent', 4.5], ['buy', 4.5], ['time', 4.5], ['series', 4.5], ['dim', 3]];

describe.each([['dark', dark], ['light', light]] as const)('the %s theme', (_name, t) => {
  const c = (k: string) => resolve(t, t[k]!);
  it('[critical] every colour that is read stands out from the panel and the page', () => {
    for (const [k, min] of READ) {
      for (const ground of ['panel', 'bg']) expect(contrast(c(k), c(ground)), `${k} on ${ground}`).toBeGreaterThanOrEqual(min);
    }
  });
  it('[critical] white on each solid badge, ink on the accent fill, red words in a red box', () => {
    for (const k of ['up-fill', 'down-fill', 'warn-fill', 'neutral-fill']) expect(contrast(c(k), '#ffffff'), k).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c('accent-ink'), c('accent-fill'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c('down-text'), c('down-bg'))).toBeGreaterThanOrEqual(4.5);
  });
});

it('the light theme gives its own value to every ground and every colour that is read', () => {
  const own = block(":root[data-theme='light']");
  for (const k of ['bg', 'panel', 'panel-2', 'panel-3', 'line', 'line-soft', 'text', 'muted', 'dim', 'up', 'down', 'warn', 'accent', 'accent-fill', 'buy', 'time', 'series', 'well', 'down-text', 'up-bg', 'down-bg', 'warn-bg']) {
    expect(own[k], k).toBeDefined();
  }
  expect(own['color-scheme' as never]).toBeUndefined();
  expect(css).toMatch(/:root\[data-theme='light'\] \{[^}]*color-scheme: light;/);
});

/*
 * No colour of its own on a screen. Allowed: the token blocks themselves; white text on a solid badge; black shadows;
 * Bitcoin's own orange; the chart's palette (a canvas reads no CSS); the four strategy families' badges (solid, white
 * text, the same in both themes).
 */
const ALLOWED = [/^#fff(fff)?$/i, /^#000000[0-9a-f]{2}$/i, /^rgba\(0, ?0, ?0, ?[\d.]+\)$/, /^#f7931a$/i, /^#c86800$/i, /^rgba\(247, ?147, ?26, ?[\d.]+\)$/];
const FREE_FILES = new Set(['styles.css', 'lib/theme.ts', 'components/desk/chart/scene.ts']);
const FAMILIES = new Set(['#475569', '#7c3aed', '#db2777']);
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'test' ? [] : files(p);
    return /\.(tsx?|css)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
}
it('[critical] the screens use the tokens: no colour of their own outside the few that are the same in both themes', () => {
  const bad: string[] = [];
  for (const p of files(SRC)) {
    const rel = relative(SRC, p).replace(/\\/g, '/');
    if (FREE_FILES.has(rel) && rel !== 'styles.css') continue;
    let text = readFileSync(p, 'utf8');
    // styles.css: the token blocks are where colours belong.
    if (rel === 'styles.css') text = text.slice(text.indexOf("}", text.indexOf(":root[data-view='phone'][data-theme='light']")));
    text.split('\n').forEach((line, i) => {
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
      for (const m of line.matchAll(/#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)/g)) {
        const v = m[0];
        if (ALLOWED.some((re) => re.test(v))) continue;
        if (rel === 'components/desk/entry/parts.tsx' && FAMILIES.has(v.toLowerCase())) continue;
        bad.push(`${rel}:${i + 1} ${v}`);
      }
    });
  }
  expect(bad).toEqual([]);
});

it('[critical] white words in a stylesheet only on a ground of their own: on a panel they vanish in the light theme', () => {
  const bad: string[] = [];
  for (const p of files(SRC).filter((f) => f.endsWith('.css'))) {
    const rel = relative(SRC, p).replace(/\\/g, '/');
    for (const rule of readFileSync(p, 'utf8').split('}')) {
      if (/(^|[;{\s])color:\s*#fff(fff)?\b/i.test(rule) && !/background(-color)?:/.test(rule)) bad.push(`${rel}: ${rule.trim().split('{')[0]!.trim()}`);
    }
  }
  expect(bad).toEqual([]);
});

it('[critical] no Tailwind palette colour on a screen (text-slate-400 and the like): each is one theme\'s colour', () => {
  const bad: string[] = [];
  const palette = /\b(?:text|bg|border|ring|fill|stroke|from|to|via|divide|outline|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
  for (const p of files(SRC).filter((f) => f.endsWith('.tsx'))) {
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => { const m = palette.exec(line); if (m) bad.push(`${relative(SRC, p)}:${i + 1} ${m[0]}`); });
  }
  expect(bad).toEqual([]);
});
