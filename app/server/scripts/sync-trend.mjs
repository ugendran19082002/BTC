// Copies the trend plan (app/web/src/lib/trend/breakout.ts) into the server, which builds only its own
// src/ -- one rule for the chart, the study and the paper log. test/strategy/trend-copy.test.ts fails
// when the copy has drifted. Run: npm run sync:trend
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '../../web/src/lib/trend/breakout.ts');
const target = join(here, '../src/strategy/trend-breakout.ts');
export const HEADER = '// GENERATED from app/web/src/lib/trend/breakout.ts by `npm run sync:trend` -- edit that file, not this one.\n';
writeFileSync(target, HEADER + readFileSync(source, 'utf8'));
console.log(`wrote ${target}`);
