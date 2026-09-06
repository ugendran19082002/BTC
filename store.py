#!/usr/bin/env python3
"""SQLite store for harvested option-chain snapshots.

One file, no server, one writer. WAL mode so the API can read while the
harvester writes.

  python3 store.py import        load any chain/*.json into the database
  python3 store.py stats         what the database currently holds
"""
import sqlite3, os, json, glob, sys, datetime

DB = os.environ.get('CHAIN_DB') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'chain.db')

SCHEMA = """
CREATE TABLE IF NOT EXISTS days (
    date         TEXT PRIMARY KEY,
    v            INTEGER NOT NULL,
    spot         REAL    NOT NULL,
    settle       REAL    NOT NULL,
    atm          INTEGER NOT NULL,
    step         INTEGER NOT NULL,
    harvested_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS legs (
    date         TEXT    NOT NULL,
    cp           TEXT    NOT NULL CHECK (cp IN ('C','P')),
    k            INTEGER NOT NULL,
    off          INTEGER NOT NULL,
    ltp          REAL,
    mark         REAL,
    age_min      INTEGER,
    vol_8h       REAL    NOT NULL DEFAULT 0,
    settle_value REAL    NOT NULL,
    PRIMARY KEY (date, cp, k),
    FOREIGN KEY (date) REFERENCES days(date) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS legs_by_day  ON legs(date);
CREATE INDEX IF NOT EXISTS legs_by_mark ON legs(date, cp, mark);
"""


def connect(path=DB, readonly=False):
    if readonly:
        con = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=15)
    else:
        con = sqlite3.connect(path, timeout=30)
        con.executescript(SCHEMA)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA foreign_keys=ON')
    con.execute('PRAGMA synchronous=NORMAL')
    return con


def have_day(con, date, version):
    r = con.execute('SELECT v FROM days WHERE date = ?', (date,)).fetchone()
    return r is not None and r['v'] == version


def save_day(con, rec):
    """Replace one day atomically: a half-written day is never visible."""
    with con:
        con.execute('DELETE FROM days WHERE date = ?', (rec['date'],))
        con.execute(
            'INSERT INTO days (date, v, spot, settle, atm, step, harvested_at)'
            ' VALUES (?,?,?,?,?,?,?)',
            (rec['date'], rec.get('v', 1), rec['spot'], rec['settle'], rec['atm'],
             rec['step'], datetime.datetime.now(datetime.timezone.utc).isoformat()),
        )
        con.executemany(
            'INSERT INTO legs (date, cp, k, off, ltp, mark, age_min, vol_8h, settle_value)'
            ' VALUES (?,?,?,?,?,?,?,?,?)',
            [(rec['date'], l['cp'], l['k'], l['off'], l['ltp'], l['mark'],
              l['age_min'], l['vol_8h'], l['settle_value']) for l in rec['legs']],
        )


def import_json(pattern='chain/*.json'):
    con = connect()
    n = skipped = 0
    for f in sorted(glob.glob(pattern)):
        try:
            rec = json.load(open(f))
        except Exception:
            skipped += 1
            continue
        if not rec.get('ok') or len(rec.get('legs') or []) < 20:
            skipped += 1
            continue
        save_day(con, rec)
        n += 1
    print(f'imported {n} days, skipped {skipped}')
    return n


def stats():
    if not os.path.exists(DB):
        print('no database yet'); return
    con = connect(readonly=True)
    d = con.execute('SELECT COUNT(*) n, MIN(date) a, MAX(date) b FROM days').fetchone()
    l = con.execute('SELECT COUNT(*) n FROM legs').fetchone()
    print(f"days {d['n']}  range {d['a']} .. {d['b']}  legs {l['n']}")
    for r in con.execute(
        "SELECT substr(date,1,4) y, COUNT(*) n FROM days GROUP BY y ORDER BY y"
    ):
        print(f"  {r['y']}  {r['n']} days")


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'stats'
    if cmd == 'import':
        import_json()
        stats()
    else:
        stats()
