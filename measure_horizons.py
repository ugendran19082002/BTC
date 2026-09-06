#!/usr/bin/env python3
"""Store how BTC actually moves at each horizon, so the desk reads it rather
than carrying hard-coded numbers.

Direction is stored too, and it is stored precisely because it is a coin flip:
having the measurement on the page is what stops someone adding a direction
forecast later on a hunch.

  python3 measure_horizons.py [days]
"""
import datetime, sys
import store
from study_horizons import candles, ema, HORIZONS

SCHEMA = """
CREATE TABLE IF NOT EXISTS horizons (
    minutes      INTEGER PRIMARY KEY,
    label        TEXT    NOT NULL,
    windows      INTEGER NOT NULL,
    move_median  REAL    NOT NULL,   -- close-to-close, percent
    move_p68     REAL    NOT NULL,
    move_p95     REAL    NOT NULL,
    move_worst   REAL    NOT NULL,
    range_median REAL    NOT NULL,   -- high-to-low inside the window, percent
    range_p68    REAL    NOT NULL,
    range_p95    REAL    NOT NULL,
    p_up         REAL    NOT NULL,   -- share of windows that closed higher
    p_up_trend   REAL    NOT NULL,   -- the same, when the trend was rising
    measured_at  TEXT    NOT NULL,
    sample_days  INTEGER NOT NULL
);
"""


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 365
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    bars = candles('5m', now - days * 86400, now, 300)
    if len(bars) < 5000:
        raise SystemExit(f'only {len(bars)} bars; refusing to measure on that')

    closes = [b['close'] for b in bars]
    highs = [b['high'] for b in bars]
    lows = [b['low'] for b in bars]
    e9, e21 = ema(closes, 9 * 12), ema(closes, 21 * 12)
    span = int((bars[-1]['time'] - bars[0]['time']) / 86400)
    print(f'{len(bars):,} bars over {span} days')

    con = store.connect()
    con.executescript(SCHEMA)
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()

    with con:
        con.execute('DELETE FROM horizons')
        for mins, label in HORIZONS:
            step = mins // 5
            moves, ranges = [], []
            up = total = up_tr = n_tr = 0
            for i in range(len(closes) - step):
                a, b = closes[i], closes[i + step]
                moves.append(abs(b - a) / a * 100)
                total += 1
                up += b > a
                if e9[i] > e21[i]:
                    n_tr += 1
                    up_tr += b > a
            for i in range(0, len(closes) - step, max(1, step // 4)):
                hi = max(highs[i:i + step + 1])
                lo = min(lows[i:i + step + 1])
                ranges.append((hi - lo) / closes[i] * 100)
            moves.sort(); ranges.sort()
            q = lambda xs, p: xs[min(int(p * len(xs)), len(xs) - 1)]
            con.execute(
                'INSERT INTO horizons VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (mins, label, total,
                 q(moves, .5), q(moves, .68), q(moves, .95), moves[-1],
                 q(ranges, .5), q(ranges, .68), q(ranges, .95),
                 up / total, (up_tr / n_tr) if n_tr else 0.5,
                 stamp, span))
            print(f'  {label:>4}  median {q(moves,.5):.2f}%  68% {q(moves,.68):.2f}%  '
                  f'95% {q(moves,.95):.2f}%  up {100*up/total:.1f}%')


if __name__ == '__main__':
    main()
