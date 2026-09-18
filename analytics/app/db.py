"""The measured tables, read-only, reloaded when the research job rewrites them."""
import json
import os
import sqlite3
import threading
from dataclasses import dataclass

DEFAULT_DB = os.path.join(os.path.dirname(__file__), '..', '..', 'chain.db')


@dataclass(frozen=True)
class StateRow:
    minutes: int
    feature: str          # 'any' | 'momentum' | 'rsi' | 'ema'
    bucket: str
    windows: int
    independent: int      # windows / bars in the horizon: the sample that does not overlap
    side_band_pct: float  # the tercile of |move|, in percent
    p_down: float
    p_side: float
    p_up: float
    q16_pct: float | None
    q50_pct: float | None
    q84_pct: float | None
    lean_holds: bool      # the up-vs-down lean held in 2024, 2025 and 2026, z > 3
    side_holds: bool      # the calmer/livelier reading held the same way
    by_year: dict
    measured_at: str


@dataclass(frozen=True)
class ChainRow(StateRow):
    """A chain reading at the 05:30 → 17:30 horizon, with the terciles it was cut at.

    The same shape as a candle state, so the card's rules (`shown`,
    `informativeness`) apply to it unchanged, plus `lo` and `hi`: live values are
    bucketed against the cut points the history was, never re-derived.
    """
    lo: float | None = None
    hi: float | None = None


def default_path() -> str:
    """
    Where the measured tables are read from.

    ANALYTICS_DB first: in production the service keeps its tables in a database
    of its own (`/srv/data/analytics.db`), created and owned by its own user. The
    shared chain.db belongs to other processes -- on 17 September it was owned by
    uid 1001 with the API's -wal and -shm files owned by uid 1000, so nothing but
    root could write it, and a write by root risked leaving files the read-only
    API could not reopen. CHAIN_DB, then the repo's chain.db, are for local work.
    """
    return os.environ.get('ANALYTICS_DB') or os.environ.get('CHAIN_DB') or DEFAULT_DB


class States:
    """`outlook_states` and `chain_states`, cached against the file's modification time."""

    def __init__(self, path: str | None = None):
        self.path = os.path.abspath(path or default_path())
        self._lock = threading.Lock()
        self._stamp = None
        self._rows: dict[tuple[int, str, str], StateRow] = {}
        self._chain: dict[tuple[str, str], ChainRow] = {}

    def _stamp_now(self):
        try:
            return os.stat(self.path).st_mtime_ns, os.stat(self.path + '-wal').st_mtime_ns if os.path.exists(self.path + '-wal') else 0
        except FileNotFoundError:
            return None

    def rows(self) -> dict[tuple[int, str, str], StateRow]:
        self._refresh()
        return self._rows

    def chain(self) -> dict[tuple[str, str], ChainRow]:
        """`chain_states` by (feature, bucket). Empty when not measured: the cards then use candles only."""
        self._refresh()
        return self._chain

    def _refresh(self) -> None:
        stamp = self._stamp_now()
        with self._lock:
            if stamp is None:
                self._rows, self._chain, self._stamp = {}, {}, None
                return
            if stamp == self._stamp:
                return
            try:
                # mode=ro: the service never writes; the WAL still needs the directory writable
                con = sqlite3.connect(f'file:{self.path}?mode=ro', uri=True)
                try:
                    cur = con.execute('SELECT minutes, feature, bucket, windows, independent, side_band_pct, '
                                      'p_down, p_side, p_up, q16_pct, q50_pct, q84_pct, lean_holds, side_holds, '
                                      'by_year, measured_at FROM outlook_states')
                    rows = {}
                    for r in cur.fetchall():
                        row = StateRow(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11],
                                       bool(r[12]), bool(r[13]), json.loads(r[14] or '{}'), r[15])
                        rows[(row.minutes, row.feature, row.bucket)] = row
                finally:
                    con.close()
            except sqlite3.Error:
                rows = {}
            self._rows, self._chain, self._stamp = rows, self._load_chain(), stamp

    def _load_chain(self) -> dict[tuple[str, str], ChainRow]:
        """Optional: a database published before 17 September has no `chain_states`, and that is fine."""
        try:
            con = sqlite3.connect(f'file:{self.path}?mode=ro', uri=True)
            try:
                cur = con.execute('SELECT minutes, feature, bucket, windows, independent, side_band_pct, '
                                  'p_down, p_side, p_up, q16_pct, q50_pct, q84_pct, lean_holds, side_holds, '
                                  'by_year, measured_at, lo, hi FROM chain_states')
                out = {}
                for r in cur.fetchall():
                    row = ChainRow(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11],
                                   bool(r[12]), bool(r[13]), json.loads(r[14] or '{}'), r[15], r[16], r[17])
                    out[(row.feature, row.bucket)] = row
                return out
            finally:
                con.close()
        except sqlite3.Error:
            return {}
