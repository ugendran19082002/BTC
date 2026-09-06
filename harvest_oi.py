#!/usr/bin/env python3
"""Open interest on the legs the strategy sells, so OI can actually be tested.

chain.db has option volume but no open interest, which makes every question
about OI build-up unanswerable. This walks the OI series for the two legs a
given premium floor would have sold and records the level at entry and how fast
it was changing.

  python3 harvest_oi.py [floor]
"""
import datetime, sys
import concurrent.futures as cf
import store
from harvest_chain import candles, Unavailable

FLOOR = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS oi (
    date       TEXT NOT NULL,
    cp         TEXT NOT NULL,
    k          INTEGER NOT NULL,
    floor      REAL NOT NULL,
    oi_entry   REAL NOT NULL,
    oi_8h_ago  REAL,
    oi_change  REAL,          -- entry minus 8h earlier
    oi_accel   REAL,          -- last 2h change minus the 2h before it
    PRIMARY KEY (date, cp, floor)
);
"""


def pick(con, date, cp, floor):
    d = con.execute('SELECT atm FROM days WHERE date = ?', (date,)).fetchone()
    if not d:
        return None
    side = 'k > ?' if cp == 'C' else 'k < ?'
    r = con.execute(
        f'SELECT k FROM legs WHERE date = ? AND cp = ? AND {side} AND mark >= ?'
        ' ORDER BY mark ASC LIMIT 1', (date, cp, d['atm'], floor)).fetchone()
    return r['k'] if r else None


def walk(date, cp, k):
    day = datetime.date.fromisoformat(date)
    t0 = int(datetime.datetime.combine(day, datetime.time(0, 0),
                                       datetime.timezone.utc).timestamp())
    bars = candles(f'OI:{cp}-BTC-{k}-{day.strftime("%d%m%y")}', t0 - 8 * 3600, t0 + 60)
    if len(bars) < 30:
        raise Unavailable(f'{len(bars)} oi bars')
    at = lambda t: next((c['close'] for tt, c in sorted(bars.items()) if tt >= t), None)
    entry = bars.get(t0, {}).get('close') or at(t0 - 300)
    if entry is None:
        raise Unavailable('no oi at entry')
    back8 = at(t0 - 8 * 3600)
    back2 = at(t0 - 2 * 3600)
    back4 = at(t0 - 4 * 3600)
    accel = None
    if back2 is not None and back4 is not None:
        accel = (entry - back2) - (back2 - back4)
    return dict(oi_entry=entry, oi_8h_ago=back8,
                oi_change=None if back8 is None else entry - back8,
                oi_accel=accel)


def main():
    con = store.connect()
    con.executescript(SCHEMA)
    dates = [r['date'] for r in con.execute('SELECT date FROM days ORDER BY date')]
    done = {(r['date'], r['cp']) for r in
            con.execute('SELECT date, cp FROM oi WHERE floor = ?', (FLOOR,))}
    jobs = []
    for d in dates:
        for cp in 'CP':
            if (d, cp) in done:
                continue
            k = pick(con, d, cp, FLOOR)
            if k:
                jobs.append((d, cp, k))
    print(f'{len(jobs)} legs', flush=True)

    def one(j):
        d, cp, k = j
        try:
            return j, walk(d, cp, k)
        except Unavailable:
            return j, None

    n = skipped = 0
    with cf.ThreadPoolExecutor(5) as ex:
        for (d, cp, k), res in ex.map(one, jobs):
            if res is None:
                skipped += 1
                continue
            with con:
                con.execute('INSERT OR REPLACE INTO oi (date,cp,k,floor,oi_entry,'
                            'oi_8h_ago,oi_change,oi_accel) VALUES (?,?,?,?,?,?,?,?)',
                            (d, cp, k, FLOOR, res['oi_entry'], res['oi_8h_ago'],
                             res['oi_change'], res['oi_accel']))
            n += 1
            if n % 200 == 0:
                print(f'  {n}', flush=True)
    print(f'done: {n} written, {skipped} skipped', flush=True)


if __name__ == '__main__':
    main()
