#!/usr/bin/env python3
"""Intraday mark paths for the legs the strategy actually sells.

Answers the exit questions the settlement-only data cannot: does booking at 95%
of the credit beat holding, and would a stop-loss have helped or hurt.

For each expiry day it picks the strike a given premium floor would have sold,
then walks the 1-minute mark series from 05:30 IST to settlement and records:
  - the mark at each hour
  - the running low and high, and when they happened
  - the first minute the mark fell to 50/30/20/10/5% of the entry credit
  - the first minute the mark rose to 1.5/2/3/5x the entry credit

  python3 harvest_paths.py [floor]
"""
import datetime, sys, time
import concurrent.futures as cf
import store
from harvest_chain import candles, Unavailable

FLOOR = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0
DECAY = [0.5, 0.3, 0.2, 0.1, 0.05]
SPIKE = [1.5, 2.0, 3.0, 5.0]

SCHEMA = """
CREATE TABLE IF NOT EXISTS paths (
    date      TEXT NOT NULL,
    cp        TEXT NOT NULL,
    k         INTEGER NOT NULL,
    floor     REAL NOT NULL,
    entry     REAL NOT NULL,
    low       REAL NOT NULL,
    low_min   INTEGER NOT NULL,
    high      REAL NOT NULL,
    high_min  INTEGER NOT NULL,
    hourly    TEXT NOT NULL,   -- JSON list of 13 marks, hour 0..12
    decay     TEXT NOT NULL,   -- JSON {fraction: first minute reached, or null}
    spike     TEXT NOT NULL,   -- JSON {multiple: first minute reached, or null}
    PRIMARY KEY (date, cp, floor)
);
"""


def pick(con, date, cp, floor):
    """The furthest out-of-the-money strike that still paid the floor."""
    d = con.execute('SELECT atm FROM days WHERE date = ?', (date,)).fetchone()
    if not d:
        return None
    side = 'k > ?' if cp == 'C' else 'k < ?'
    row = con.execute(
        f"SELECT k, mark FROM legs WHERE date = ? AND cp = ? AND {side} AND mark >= ?"
        ' ORDER BY mark ASC LIMIT 1',
        (date, cp, d['atm'], floor),
    ).fetchone()
    return (row['k'], row['mark']) if row else None


def walk(date, cp, k, entry):
    import json
    day = datetime.date.fromisoformat(date)
    t0 = int(datetime.datetime.combine(day, datetime.time(0, 0),
                                       datetime.timezone.utc).timestamp())
    bars = candles(f'MARK:{cp}-BTC-{k}-{day.strftime("%d%m%y")}', t0, t0 + 12 * 3600)
    if len(bars) < 60:
        raise Unavailable(f'{len(bars)} mark bars')

    series = sorted(bars.items())
    low = high = entry
    low_min = high_min = 0
    decay = {str(f): None for f in DECAY}
    spike = {str(m): None for m in SPIKE}
    hourly = [None] * 13

    for t, c in series:
        m = (t - t0) // 60
        px = c['close']
        if px < low:
            low, low_min = px, m
        if px > high:
            high, high_min = px, m
        if m % 60 == 0 and 0 <= m // 60 <= 12:
            hourly[m // 60] = px
        for f in DECAY:
            if decay[str(f)] is None and px <= entry * f:
                decay[str(f)] = m
        for mult in SPIKE:
            if spike[str(mult)] is None and px >= entry * mult:
                spike[str(mult)] = m

    return dict(low=low, low_min=low_min, high=high, high_min=high_min,
                hourly=json.dumps(hourly), decay=json.dumps(decay),
                spike=json.dumps(spike))


def main():
    import json
    con = store.connect()
    con.executescript(SCHEMA)
    dates = [r['date'] for r in con.execute('SELECT date FROM days ORDER BY date')]
    done = {(r['date'], r['cp']) for r in
            con.execute('SELECT date, cp FROM paths WHERE floor = ?', (FLOOR,))}

    jobs = []
    for d in dates:
        for cp in 'CP':
            if (d, cp) in done:
                continue
            p = pick(con, d, cp, FLOOR)
            if p:
                jobs.append((d, cp, p[0], p[1]))
    print(f'{len(jobs)} legs to walk at floor ${FLOOR:g}', flush=True)

    def one(job):
        d, cp, k, entry = job
        try:
            return job, walk(d, cp, k, entry)
        except Unavailable as e:
            return job, None

    n = skipped = 0
    with cf.ThreadPoolExecutor(5) as ex:
        for (d, cp, k, entry), res in ex.map(one, jobs):
            if res is None:
                skipped += 1
                continue
            with con:
                con.execute(
                    'INSERT OR REPLACE INTO paths'
                    ' (date, cp, k, floor, entry, low, low_min, high, high_min,'
                    '  hourly, decay, spike) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    (d, cp, k, FLOOR, entry, res['low'], res['low_min'],
                     res['high'], res['high_min'], res['hourly'], res['decay'],
                     res['spike']),
                )
            n += 1
            if n % 100 == 0:
                print(f'  {n} legs, last {d} {cp}', flush=True)
    print(f'done: {n} written, {skipped} skipped', flush=True)


if __name__ == '__main__':
    main()
