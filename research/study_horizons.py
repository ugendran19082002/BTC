#!/usr/bin/env python3
"""How does BTC actually move over 5m, 15m, 1h, 2h, 3h, 4h, 6h and 12h?

Two questions, kept apart:

  How FAR   -- the distribution of absolute moves. Measurable, stable, useful.
  Which WAY -- whether anything we know shifts the odds of up versus down.

The second is the one people want and the one the data is stingy about. This
measures it rather than assuming it, including whether the momentum state that
helps with position sizing says anything about direction at these horizons.

  python3 study_horizons.py
"""
import datetime, json, math, ssl, statistics as st, sys, urllib.request

CTX = ssl.create_default_context()
HORIZONS = [(5, '5m'), (15, '15m'), (60, '1h'), (120, '2h'),
            (180, '3h'), (240, '4h'), (360, '6h'), (720, '12h')]


def _fetch(resolution, start, end):
    u = ('https://api.india.delta.exchange/v2/history/candles'
         f'?resolution={resolution}&symbol=BTCUSD&start={start}&end={end}')
    r = urllib.request.Request(u, headers={'Accept': 'application/json', 'User-Agent': 'curl/8'})
    with urllib.request.urlopen(r, timeout=60, context=CTX) as f:
        return json.loads(f.read().decode())['result']


def candles(resolution, start, end, bar_seconds):
    """Page backwards. The endpoint caps a response at about 2000 bars, so a
    single call silently truncates to a fortnight of 5-minute data -- which is
    nowhere near enough to say anything about direction."""
    out = {}
    cursor = end
    while cursor > start:
        chunk = _fetch(resolution, max(start, cursor - 1800 * bar_seconds), cursor)
        if not chunk:
            break
        before = len(out)
        for c in chunk:
            out[c['time']] = c
        if len(out) == before:
            break
        cursor = min(c['time'] for c in chunk) - bar_seconds
    return [out[t] for t in sorted(out)]


def ema(xs, n):
    k = 2 / (n + 1); e = None; out = []
    for x in xs:
        e = x if e is None else x * k + e * (1 - k)
        out.append(e)
    return out


def main():
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 365
    bars = candles('5m', now - days * 86400, now, 300)
    span = (bars[-1]['time'] - bars[0]['time']) / 86400 if len(bars) > 1 else 0
    print(f'{len(bars):,} five-minute bars, {span:.0f} days\n')

    closes = [b['close'] for b in bars]
    highs = [b['high'] for b in bars]
    lows = [b['low'] for b in bars]
    e9, e21 = ema(closes, 9 * 12), ema(closes, 21 * 12)   # in 5m bars: 9h and 21h

    print('=' * 104)
    print('  HOW FAR BTC MOVES — every overlapping window in the sample')
    print('=' * 104)
    print(f"  {'horizon':>8} {'windows':>8} {'median':>9} {'68% within':>12} "
          f"{'95% within':>12} {'worst seen':>12}")
    stats = {}
    for mins, label in HORIZONS:
        step = mins // 5
        moves = []
        for i in range(0, len(closes) - step):
            a, b = closes[i], closes[i + step]
            moves.append(abs(b - a) / a * 100)
        moves.sort()
        med = moves[len(moves) // 2]
        p68 = moves[int(0.68 * len(moves))]
        p95 = moves[int(0.95 * len(moves))]
        stats[label] = dict(median=med, p68=p68, p95=p95, worst=moves[-1], n=len(moves))
        print(f"  {label:>8} {len(moves):>8} {med:>8.2f}% {p68:>11.2f}% "
              f"{p95:>11.2f}% {moves[-1]:>11.2f}%")

    print()
    print('=' * 104)
    print('  WHICH WAY — does anything we know shift the odds of up versus down?')
    print('=' * 104)
    print('  A coin flip is 50%. Anything inside roughly 48-52% is noise at this sample size.\n')
    print(f"  {'horizon':>8} {'all windows':>13} {'after an up bar':>17} "
          f"{'trend rising':>15} {'trend falling':>15}")
    for mins, label in HORIZONS:
        step = mins // 5
        allup = up_after_up = n_after_up = up_rising = n_rising = up_falling = n_falling = 0
        total = 0
        for i in range(step, len(closes) - step):
            fwd = closes[i + step] - closes[i]
            total += 1
            allup += fwd > 0
            if closes[i] > closes[i - step]:
                n_after_up += 1
                up_after_up += fwd > 0
            if e9[i] > e21[i]:
                n_rising += 1
                up_rising += fwd > 0
            else:
                n_falling += 1
                up_falling += fwd > 0
        pc = lambda a, b: f'{100 * a / b:.1f}%' if b else '—'
        print(f"  {label:>8} {pc(allup, total):>13} {pc(up_after_up, n_after_up):>17} "
              f"{pc(up_rising, n_rising):>15} {pc(up_falling, n_falling):>15}")

    print()
    print('=' * 104)
    print('  RANGE, NOT JUST CLOSE — how far it travels inside the window')
    print('=' * 104)
    print(f"  {'horizon':>8} {'median range':>14} {'68%':>9} {'95%':>9}")
    for mins, label in HORIZONS:
        step = mins // 5
        ranges = []
        for i in range(0, len(closes) - step, max(1, step // 4)):
            hi = max(highs[i:i + step + 1])
            lo = min(lows[i:i + step + 1])
            ranges.append((hi - lo) / closes[i] * 100)
        ranges.sort()
        print(f"  {label:>8} {ranges[len(ranges)//2]:>13.2f}% "
              f"{ranges[int(.68*len(ranges))]:>8.2f}% {ranges[int(.95*len(ranges))]:>8.2f}%")

    print()
    print('  Ranges are wider than close-to-close moves at every horizon: price')
    print('  visits levels it does not end at. For a seller that gap is the whole')
    print('  difference between "expired worthless" and "never went near it".')


if __name__ == '__main__':
    main()
