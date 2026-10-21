import { closeSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The server's log, kept on disk as well as on stdout (21 Oct 2026, owner's list #6: "the logs disappear").
 *
 * Docker keeps a container's stdout only as long as the container: every rebuild started a new one and the old log
 * went with it -- the 13:01 target on 20 Oct could not be traced past the 13:08 build. Now each line goes to stdout as
 * before *and* to one file a day (`api-YYYY-MM-DD.log`, the IST day) in `LOG_DIR`, a volume of its own that outlives
 * the container. Kept `LOG_KEEP_DAYS` days and at most `LOG_MAX_MB` in all, the oldest day going first; today's file is
 * never removed.
 *
 * Written synchronously, a line at a time: a crash keeps every line written before it, and the desk logs a few lines a
 * minute. A file that cannot be written -- the disk full, the volume missing -- is said once on stdout and then left
 * alone; stdout goes on. Logging never throws.
 */

const IST_MS = 330 * 60_000;
const FILE = /^api-(\d{4}-\d{2}-\d{2})\.log$/;
export const dayOfLog = (now: number) => new Date(now + IST_MS).toISOString().slice(0, 10);

export type LogFilesOptions = {
  dir: string;
  keepDays: number;
  maxBytes: number;
  now?: () => number;
  /** Where every line goes as well; stdout unless a test says otherwise. */
  out?: { write: (line: string) => unknown };
};

export type LogStream = { write: (line: string) => void; close: () => void };

export function logFiles(o: LogFilesOptions): LogStream {
  const now = o.now ?? Date.now;
  const out = o.out ?? process.stdout;
  let day: string | null = null;
  let fd: number | null = null;
  let broken = false;

  const fail = (what: string, e: unknown) => {
    broken = true;
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } fd = null; }
    out.write(`${JSON.stringify({ level: 40, time: now(), msg: `log files off: ${what} in ${o.dir} failed (${e instanceof Error ? e.message : String(e)}); stdout only from here` })}\n`);
  };

  /** The days past keeping, then the oldest while over the size; never today's. */
  const sweep = (today: string) => {
    const files = readdirSync(o.dir)
      .map((name) => ({ name, day: FILE.exec(name)?.[1] }))
      .filter((f): f is { name: string; day: string } => f.day !== undefined && f.day !== today)
      .map((f) => ({ ...f, bytes: statSync(join(o.dir, f.name)).size }))
      .sort((a, b) => a.day.localeCompare(b.day));
    const oldest = dayOfLog(now() - o.keepDays * 86_400_000);
    let total = files.reduce((n, f) => n + f.bytes, 0) + (fd !== null ? statSync(join(o.dir, `api-${today}.log`)).size : 0);
    for (const f of files) {
      if (f.day >= oldest && total <= o.maxBytes) break;
      unlinkSync(join(o.dir, f.name));
      total -= f.bytes;
    }
  };

  const open = (d: string) => {
    if (fd !== null) closeSync(fd);
    fd = openSync(join(o.dir, `api-${d}.log`), 'a');
    day = d;
    // Old days not removed is no reason to stop writing today's.
    try { sweep(d); } catch (e) {
      out.write(`${JSON.stringify({ level: 40, time: now(), msg: `log files: removing old days in ${o.dir} failed (${e instanceof Error ? e.message : String(e)})` })}\n`);
    }
  };

  return {
    write(line: string) {
      out.write(line);
      if (broken) return;
      const d = dayOfLog(now());
      try {
        if (d !== day) open(d);
      } catch (e) { fail('opening the day\'s file', e); return; }
      try {
        writeSync(fd!, line);
      } catch (e) { fail('writing', e); }
    },
    close() {
      if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } fd = null; }
    },
  };
}
