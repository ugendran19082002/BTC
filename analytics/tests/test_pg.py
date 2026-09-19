"""
The PostgreSQL home of the measured tables, end to end: publish, read, re-publish.

Runs only when TEST_PG_URL names a server (deploy/test-db.sh up gives one on
127.0.0.1:5433); the model tests need no database at all.
"""
import os
import sqlite3
import sys
import uuid

import pytest

from app.db import PgStates, open_states
from tests.conftest import CHAIN_ROWS, CHAIN_SCHEMA, SCHEMA, row

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'research'))

ADMIN = os.environ.get('TEST_PG_URL')
pytestmark = pytest.mark.skipif(not ADMIN, reason='TEST_PG_URL not set: no PostgreSQL to test against')


@pytest.fixture
def pg_url():
    """A database of its own for the test, dropped afterwards."""
    import psycopg
    name = f'btc_test_{uuid.uuid4().hex[:12]}'
    with psycopg.connect(ADMIN, autocommit=True) as con:
        con.execute(f'CREATE DATABASE {name}')
    base, _, _ = ADMIN.rpartition('/')
    yield f'{base}/{name}'
    with psycopg.connect(ADMIN, autocommit=True) as con:
        con.execute(f'DROP DATABASE {name} WITH (FORCE)')


@pytest.fixture
def measured(tmp_path):
    """A source file shaped like the measurement."""
    p = tmp_path / 'chain.db'
    con = sqlite3.connect(p)
    con.execute(SCHEMA)
    con.executemany('INSERT INTO outlook_states VALUES (' + ','.join('?' * 18) + ')', [
        row(60, 'momentum', 'down', 0.337, 0.271, 0.392, lean=1, sidehold=1, q=(-0.25, 0.02, 0.3)),
        row(5, 'rsi', 'oversold', 0.282, 0.371, 0.348, lean=1, q=(-0.05, 0.004, 0.06)),
    ])
    con.execute(CHAIN_SCHEMA)
    con.executemany('INSERT INTO chain_states VALUES (' + ','.join('?' * 20) + ')', CHAIN_ROWS)
    con.commit()
    con.close()
    return str(p)


def test_publish_then_read_through_the_service(measured, pg_url):
    from publish_outlook_states import publish
    assert publish(measured, pg_url) == 2
    s = PgStates(pg_url)
    rows = s.rows()
    r = rows[(60, 'momentum', 'down')]
    assert (r.p_down, r.p_side, r.p_up) == (0.337, 0.271, 0.392)
    assert r.lean_holds is True and r.side_holds is True
    assert isinstance(r.by_year, dict)
    assert len(s.chain()) == len(CHAIN_ROWS)
    assert s.chain()[('implied_move', 'large')].side_holds is True


def test_a_republish_is_picked_up_without_a_restart(measured, pg_url, tmp_path):
    from publish_outlook_states import publish
    publish(measured, pg_url)
    s = PgStates(pg_url, ttl=0)          # check the stamp on every read, for the test
    assert len(s.rows()) == 2
    # the measurement grows by a row and is published again
    con = sqlite3.connect(measured)
    con.execute('INSERT INTO outlook_states VALUES (' + ','.join('?' * 18) + ')',
                row(15, 'ema', 'rising', 0.34, 0.33, 0.33))
    con.commit(); con.close()
    publish(measured, pg_url)
    assert len(s.rows()) == 3, 'the stamp changed, so the tables were re-read'


def test_not_published_yet_is_no_rows_not_an_error(pg_url):
    assert PgStates(pg_url).rows() == {}


def test_a_database_that_is_away_is_no_rows_not_a_crash():
    assert PgStates('postgres://nobody:x@127.0.0.1:1/none').rows() == {}


def test_open_states_picks_postgres_when_told_where_it_is(monkeypatch, pg_url):
    monkeypatch.setenv('DATABASE_URL', pg_url)
    assert isinstance(open_states(), PgStates)
    monkeypatch.delenv('DATABASE_URL')
    assert not isinstance(open_states(), PgStates)
