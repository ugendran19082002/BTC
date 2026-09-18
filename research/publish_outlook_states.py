"""
Copy the measured `outlook_states` (and `chain_states`, when measured) tables into the analytics service's database.

    python3 research/publish_outlook_states.py SOURCE.db TARGET.db

The measurement runs against the repository's chain.db; the analytics service
reads its own database on the production volume (`/srv/data/analytics.db`),
which this creates on first publish. Run it as the service's user (uid 1000) so
the file, and its -wal and -shm, belong to the one process that reads them. This moves the table across in a single
transaction: the service keeps serving the old rows until the commit, then
reloads (it watches the file) and serves the new ones. Safe while the API and
the service are reading -- the database is in WAL mode -- and it touches no
other table.

Refuses a source that has not been measured, so a typo cannot publish nothing
over something.
"""
import os
import sqlite3
import sys


def publish(source: str, target: str) -> int:
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
        n = src.execute('SELECT COUNT(*) FROM outlook_states').fetchone()[0]
    except sqlite3.OperationalError:
        raise SystemExit(f'{source} has no outlook_states table: run research/measure_outlook.py first')
    finally:
        src.close()
    if n == 0:
        raise SystemExit(f'{source} has an empty outlook_states table; nothing published')

    con = sqlite3.connect(target, timeout=30)
    try:
        # WAL, so the service keeps reading the old rows while this writes the new.
        con.execute('PRAGMA journal_mode=WAL')
        con.execute('ATTACH DATABASE ? AS src', (uri,))
        tables = ['outlook_states']
        # chain_states is optional: measured since 17 September by measure_chain_outlook.py.
        if con.execute("SELECT 1 FROM src.sqlite_master WHERE type='table' AND name='chain_states'").fetchone():
            tables.append('chain_states')
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
    print(f'published {publish(sys.argv[1], sys.argv[2])} rows into {sys.argv[2]}')
