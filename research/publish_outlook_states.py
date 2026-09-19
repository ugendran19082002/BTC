"""
Copy the measured `outlook_states` (and `chain_states`, when measured) tables into the analytics service's database.

    python3 research/publish_outlook_states.py SOURCE.db postgres://desk:...@db:5432/btc_desk
    python3 research/publish_outlook_states.py SOURCE.db TARGET.db          # a SQLite file, for local work

The measurement runs against the repository's chain.db. In production the
analytics service reads the `analytics` schema of the desk's PostgreSQL
database, so the target is its URL: the two tables are replaced and
`analytics.publish_meta.published_at` stamped in one transaction, and the
service (which checks the stamp every half minute) serves the new rows without
a restart. A SQLite target still works for local runs.

Refuses a source that has not been measured, so a typo cannot publish nothing
over something.
"""
import json
import os
import sqlite3
import sys
import time

OUTLOOK_COLS = ['minutes', 'feature', 'bucket', 'windows', 'independent', 'side_band_pct', 'p_down', 'p_side', 'p_up',
                'q16_pct', 'q50_pct', 'q84_pct', 'by_year', 'lean_holds', 'side_holds', 'lean_z', 'side_z', 'measured_at']
CHAIN_COLS = OUTLOOK_COLS[:3] + ['lo', 'hi'] + OUTLOOK_COLS[3:]
JSON_COLS = {'by_year'}
BOOL_COLS = {'lean_holds', 'side_holds'}


def _source(source: str) -> tuple[str, list[str]]:
    """Check the source, and say which tables it has."""
    # The source is a finished measurement, opened `immutable` so it needs no
    # write access to its own -shm file (the repo's copy may belong to another
    # user). Immutable skips the WAL, so a source with pages still in it would be
    # read short: refuse it rather than publish a partial table.
    wal = source + '-wal'
    if os.path.exists(wal) and os.path.getsize(wal) > 0:
        raise SystemExit(f'{source} has un-checkpointed WAL pages; open it once with sqlite3 and close it, then retry')
    uri = f'file:{source}?mode=ro&immutable=1'
    src = sqlite3.connect(uri, uri=True)
    try:
        try:
            n = src.execute('SELECT COUNT(*) FROM outlook_states').fetchone()[0]
        except sqlite3.OperationalError:
            raise SystemExit(f'{source} has no outlook_states table: run research/measure_outlook.py first')
        if n == 0:
            raise SystemExit(f'{source} has an empty outlook_states table; nothing published')
        tables = ['outlook_states']
        # chain_states is optional: measured since 17 September by measure_chain_outlook.py.
        if src.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chain_states'").fetchone():
            tables.append('chain_states')
    finally:
        src.close()
    return uri, tables


def publish_pg(source: str, url: str) -> int:
    """Replace the tables in the `analytics` schema, and stamp the publish, in one transaction."""
    import psycopg
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'analytics'))
    from app.db import PG_SCHEMA  # the one definition of the tables

    uri, tables = _source(source)
    src = sqlite3.connect(uri, uri=True)
    try:
        data = {t: src.execute(f'SELECT {", ".join(OUTLOOK_COLS if t == "outlook_states" else CHAIN_COLS)} FROM {t}').fetchall()
                for t in tables}
    finally:
        src.close()

    def cell(col, v):
        if col in JSON_COLS:
            return psycopg.types.json.Jsonb(json.loads(v) if isinstance(v, str) else (v or {}))
        if col in BOOL_COLS:
            return None if v is None else bool(v)
        return v

    with psycopg.connect(url, application_name='btc-desk-publish') as con:
        with con.transaction():
            con.execute(PG_SCHEMA)
            for t, rows in data.items():
                cols = OUTLOOK_COLS if t == 'outlook_states' else CHAIN_COLS
                con.execute(f'DELETE FROM analytics.{t}')
                with con.cursor() as cur:
                    cur.executemany(
                        f'INSERT INTO analytics.{t} ({", ".join(cols)}) VALUES ({", ".join("%s" for _ in cols)})',
                        [[cell(c, v) for c, v in zip(cols, r)] for r in rows],
                    )
            con.execute('INSERT INTO analytics.publish_meta (id, published_at) VALUES (1, %s) '
                        'ON CONFLICT (id) DO UPDATE SET published_at = EXCLUDED.published_at', (int(time.time() * 1000),))
        return con.execute('SELECT COUNT(*) FROM analytics.outlook_states').fetchone()[0]


def publish(source: str, target: str) -> int:
    """A SQLite target, for local work: the tables copied across in one transaction."""
    if target.startswith(('postgres://', 'postgresql://')):
        return publish_pg(source, target)
    uri, tables = _source(source)

    con = sqlite3.connect(target, timeout=30)
    try:
        # WAL, so a reader keeps the old rows while this writes the new.
        con.execute('PRAGMA journal_mode=WAL')
        con.execute('ATTACH DATABASE ? AS src', (uri,))
        ddls = {t: con.execute("SELECT sql FROM src.sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()[0]
                for t in tables}
        con.execute('BEGIN IMMEDIATE')
        for t in tables:
            con.execute(f'DROP TABLE IF EXISTS main.{t}')
            con.execute(ddls[t])
            con.execute(f'INSERT INTO main.{t} SELECT * FROM src.{t}')
        con.execute('COMMIT')
        return con.execute('SELECT COUNT(*) FROM main.outlook_states').fetchone()[0]
    except Exception:
        con.execute('ROLLBACK') if con.in_transaction else None
        raise
    finally:
        con.close()


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    import re
    # never the password: this line lands in terminals and cron logs
    shown = re.sub(r'://([^:@/]+):[^@/]*@', r'://\1:***@', sys.argv[2])
    print(f'published {publish(sys.argv[1], sys.argv[2])} rows into {shown}')
