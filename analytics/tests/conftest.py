"""A small outlook_states table on disk, shaped like the measured one."""
import json
import sqlite3

import pytest

from app.db import States

SCHEMA = '''CREATE TABLE outlook_states (
  minutes INTEGER, feature TEXT, bucket TEXT, windows INTEGER, independent INTEGER, side_band_pct REAL,
  p_down REAL, p_side REAL, p_up REAL, q16_pct REAL, q50_pct REAL, q84_pct REAL,
  by_year TEXT, lean_holds INTEGER, side_holds INTEGER, lean_z REAL, side_z REAL,
  measured_at TEXT, PRIMARY KEY (minutes, feature, bucket))'''


CHAIN_SCHEMA = '''CREATE TABLE chain_states (
  minutes INTEGER, feature TEXT, bucket TEXT, lo REAL, hi REAL, windows INTEGER, independent INTEGER,
  side_band_pct REAL, p_down REAL, p_side REAL, p_up REAL, q16_pct REAL, q50_pct REAL, q84_pct REAL,
  by_year TEXT, lean_holds INTEGER, side_holds INTEGER, lean_z REAL, side_z REAL, measured_at TEXT,
  PRIMARY KEY (minutes, feature, bucket))'''


def chain_row(feature, bucket, lo, hi, down, side, up, lean=0, sidehold=0, q=(-0.5, 0.0, 0.5)):
    return (720, feature, bucket, lo, hi, 244, 244, 0.378, down, side, up, q[0], q[1], q[2], '{}',
            lean, sidehold, 0.0, 0.0, '2026-09-17T00:00:00+00:00')


# Shaped like the 17 September measurement: a large implied move held livelier; no direction held.
CHAIN_ROWS = [
    chain_row('any', 'all', None, None, 0.317, 0.335, 0.348, q=(-0.6, 0.02, 0.6)),
    chain_row('implied_move', 'small', 0.7368, 1.043, 0.258, 0.512, 0.230),
    chain_row('implied_move', 'usual', 0.7368, 1.043, 0.333, 0.301, 0.366),
    chain_row('implied_move', 'large', 0.7368, 1.043, 0.361, 0.193, 0.447, sidehold=1, q=(-1.4, 0.05, 1.5)),
    chain_row('skew', 'calls_dearer', -0.0782, 0.0249, 0.295, 0.418, 0.287),
    chain_row('skew', 'even', -0.0782, 0.0249, 0.335, 0.302, 0.363),
    chain_row('skew', 'puts_dearer', -0.0782, 0.0249, 0.324, 0.283, 0.393),
    chain_row('pcr_volume', 'more_calls', -0.271, 0.1026, 0.288, 0.325, 0.387),
    chain_row('pcr_volume', 'even', -0.271, 0.1026, 0.302, 0.339, 0.359),
    chain_row('pcr_volume', 'more_puts', -0.271, 0.1026, 0.362, 0.342, 0.296),
]


def row(minutes, feature, bucket, down, side, up, lean=0, sidehold=0, q=(-0.1, 0.0, 0.1), windows=90_000):
    return (minutes, feature, bucket, windows, windows // max(1, minutes // 5), 0.119 if minutes == 60 else 0.035,
            down, side, up, q[0], q[1], q[2], json.dumps({}), lean, sidehold, 0.0, 0.0, '2026-09-17T00:00:00+00:00')


@pytest.fixture
def db_path(tmp_path):
    p = tmp_path / 'chain.db'
    con = sqlite3.connect(p)
    con.execute(SCHEMA)
    rows = []
    for m in (5, 15, 30, 60, 120, 240, 360, 720, 1440):
        rows.append(row(m, 'any', 'all', 0.333, 0.334, 0.333, q=(-0.2, 0.001, 0.2)))
    rows += [
        # 1h: after a drop, up is favoured and the band is livelier -- both held
        row(60, 'momentum', 'down', 0.337, 0.271, 0.392, lean=1, sidehold=1, q=(-0.25, 0.02, 0.3)),
        # 1h: a quiet hour is calmer -- only the side held; its small lean did not
        row(60, 'momentum', 'flat', 0.278, 0.436, 0.287, sidehold=1, q=(-0.12, 0.004, 0.12)),
        # 1h: an EMA reading that held nothing
        row(60, 'ema', 'rising', 0.337, 0.335, 0.328),
        # 5m: RSI oversold -- only the lean held
        row(5, 'rsi', 'oversold', 0.282, 0.371, 0.348, lean=1, q=(-0.05, 0.004, 0.06)),
    ]
    con.executemany('INSERT INTO outlook_states VALUES (' + ','.join('?' * 18) + ')', rows)
    con.execute(CHAIN_SCHEMA)
    con.executemany('INSERT INTO chain_states VALUES (' + ','.join('?' * 20) + ')', CHAIN_ROWS)
    con.commit()
    con.close()
    return str(p)


@pytest.fixture
def rows(db_path):
    return States(db_path).rows()


@pytest.fixture
def chain_rows(db_path):
    return States(db_path).chain()
