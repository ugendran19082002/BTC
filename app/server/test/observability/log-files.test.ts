import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayOfLog, logFiles } from '../../src/observability/log-files.js';

/** The server log on disk, a file a day, outliving the container (21 Oct 2026, owner's list #6: "the logs disappear"). */

const DAY = 86_400_000;
// 21 Oct 2026, 10:00 IST.
const T0 = Date.UTC(2026, 9, 21, 4, 30);
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-files-'));
  const out: string[] = [];
  let at = T0;
  const clock = { set: (t: number) => { at = t; } };
  const stream = (keepDays = 30, maxBytes = 1 << 30) => logFiles({ dir, keepDays, maxBytes, now: () => at, out: { write: (l) => out.push(l) } });
  return { dir, out, clock, stream, done: () => rmSync(dir, { recursive: true, force: true }) };
};
const files = (dir: string) => readdirSync(dir).sort();

test('[critical] every line goes to stdout and to the IST day\'s file, and a new day starts a new file', () => {
  const t = setup();
  try {
    const s = t.stream();
    s.write('{"msg":"one"}\n');
    // 23:59 IST and 00:01 IST the next day: the IST day decides, not the UTC one.
    t.clock.set(Date.UTC(2026, 9, 21, 18, 29));
    s.write('{"msg":"two"}\n');
    t.clock.set(Date.UTC(2026, 9, 21, 18, 31));
    s.write('{"msg":"three"}\n');
    s.close();
    assert.deepEqual(t.out, ['{"msg":"one"}\n', '{"msg":"two"}\n', '{"msg":"three"}\n']);
    assert.deepEqual(files(t.dir), ['api-2026-10-21.log', 'api-2026-10-22.log']);
    assert.equal(readFileSync(join(t.dir, 'api-2026-10-21.log'), 'utf8'), '{"msg":"one"}\n{"msg":"two"}\n');
    assert.equal(readFileSync(join(t.dir, 'api-2026-10-22.log'), 'utf8'), '{"msg":"three"}\n');
  } finally { t.done(); }
});

test('[critical] a restart (a rebuild) appends to the day\'s file: nothing written before it is lost', () => {
  const t = setup();
  try {
    const a = t.stream();
    a.write('before\n');
    a.close();
    const b = t.stream();
    b.write('after\n');
    b.close();
    assert.equal(readFileSync(join(t.dir, 'api-2026-10-21.log'), 'utf8'), 'before\nafter\n');
  } finally { t.done(); }
});

test('[critical] days past keeping go, then the oldest while over the size; today\'s never, and other files are left alone', () => {
  const t = setup();
  try {
    for (let d = 1; d <= 40; d++) writeFileSync(join(t.dir, `api-${dayOfLog(T0 - d * DAY)}.log`), 'x'.repeat(100));
    writeFileSync(join(t.dir, 'notes.txt'), 'mine');
    const s = t.stream(30, 1_000_000);
    s.write('today\n');
    s.close();
    const kept = files(t.dir).filter((f) => f.startsWith('api-'));
    // 30 days back from 21 Oct is 21 Sep: the days 21 Sep - 20 Oct, and today.
    assert.equal(kept.length, 31);
    assert.equal(kept[0], 'api-2026-09-21.log');
    assert.ok(files(t.dir).includes('notes.txt'));

    // Over the size: the oldest days go first, until it fits; today stays even past it.
    const u = t.stream(30, 1_000);
    t.clock.set(T0 + DAY);
    u.write('tomorrow\n');
    u.close();
    const left = files(t.dir).filter((f) => f.startsWith('api-'));
    assert.deepEqual(left.slice(-2), ['api-2026-10-21.log', 'api-2026-10-22.log']);
    const bytes = left.reduce((n, f) => n + readFileSync(join(t.dir, f)).length, 0);
    assert.ok(bytes <= 1_000, `${bytes} bytes kept`);
  } finally { t.done(); }
});

test('[critical] today\'s file alone over the size: the older days go, today\'s stays and is written on', () => {
  const t = setup();
  try {
    writeFileSync(join(t.dir, `api-${dayOfLog(T0 - DAY)}.log`), 'y'.repeat(100));
    writeFileSync(join(t.dir, 'api-2026-10-21.log'), 'x'.repeat(2_000));
    const s = t.stream(30, 1_000);
    s.write('more\n');
    s.close();
    assert.deepEqual(files(t.dir), ['api-2026-10-21.log']);
    assert.equal(readFileSync(join(t.dir, 'api-2026-10-21.log'), 'utf8'), `${'x'.repeat(2_000)}more\n`);
  } finally { t.done(); }
});

test('[critical] a file that cannot be written is said once on stdout, and stdout goes on; nothing throws', { skip: process.getuid?.() === 0 }, () => {
  const t = setup();
  try {
    chmodSync(t.dir, 0o500);
    const s = t.stream();
    assert.doesNotThrow(() => { s.write('a\n'); s.write('b\n'); });
    assert.equal(t.out[0], 'a\n');
    assert.match(t.out[1]!, /log files off: opening the day's file/);
    assert.deepEqual(t.out.slice(2), ['b\n']);
    s.close();
  } finally { chmodSync(t.dir, 0o700); t.done(); }
});
