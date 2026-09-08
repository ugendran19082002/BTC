#!/usr/bin/env python3
"""Which indicators actually help, and which only look like they do?

Every candidate is tested the same way: as a filter (stand aside when it fires)
and as a skew (lean the split when it fires), against the same baseline, and
then broken out by year. A rule that only works in one year has not been shown
to work, so it does not survive.

  python3 feature_screen.py
"""
import datetime, math, statistics as st, urllib.request, json, ssl
import store
from study_premium import load, pick_floor, stats
from final_report import row

LOT, TOT, SLIP = 0.001, 10, 0.05
CTX = ssl.create_default_context()


def daily_candles(start, end):
    u = (f'https://api.india.delta.exchange/v2/history/candles?resolution=1d'
         f'&symbol=BTCUSD&start={start}&end={end}')
    r = urllib.request.Request(u, headers={'Accept': 'application/json', 'User-Agent': 'curl/8'})
    with urllib.request.urlopen(r, timeout=60, context=CTX) as f:
        return sorted(json.loads(f.read().decode())['result'], key=lambda c: c['time'])


def ema(xs, n):
    k = 2 / (n + 1)
    out, e = [], None
    for x in xs:
        e = x if e is None else x * k + e * (1 - k)
        out.append(e)
    return out


def rsi_series(xs, n=14):
    out = [None] * len(xs)
    if len(xs) < n + 1:
        return out
    g = l = 0.0
    for i in range(1, n + 1):
        d = xs[i] - xs[i - 1]
        g += max(d, 0); l += max(-d, 0)
    g /= n; l /= n
    out[n] = 100 if l == 0 else 100 - 100 / (1 + g / l)
    for i in range(n + 1, len(xs)):
        d = xs[i] - xs[i - 1]
        g = (g * (n - 1) + max(d, 0)) / n
        l = (l * (n - 1) + max(-d, 0)) / n
        out[i] = 100 if l == 0 else 100 - 100 / (1 + g / l)
    return out


def main():
    days = load()
    by = {d['date']: d for d in days}
    dates = sorted(by)

    # BTCUSD daily bars covering the period, one call
    t0 = int(datetime.datetime.fromisoformat(dates[0]).replace(
        tzinfo=datetime.timezone.utc).timestamp()) - 60 * 86400
    t1 = int(datetime.datetime.fromisoformat(dates[-1]).replace(
        tzinfo=datetime.timezone.utc).timestamp()) + 86400
    bars = daily_candles(t0, t1)
    bd = {datetime.datetime.fromtimestamp(c['time'], datetime.timezone.utc)
          .date().isoformat(): c for c in bars}
    bdates = sorted(bd)
    closes = [bd[d]['close'] for d in bdates]
    idx = {d: i for i, d in enumerate(bdates)}

    e9, e21, e12, e26 = ema(closes, 9), ema(closes, 21), ema(closes, 12), ema(closes, 26)
    macd = [a - b for a, b in zip(e12, e26)]
    sig = ema(macd, 9)
    rsi = rsi_series(closes)
    tr = [0.0] + [max(bd[bdates[i]]['high'] - bd[bdates[i]]['low'],
                      abs(bd[bdates[i]]['high'] - closes[i - 1]),
                      abs(bd[bdates[i]]['low'] - closes[i - 1]))
                  for i in range(1, len(bdates))]
    atr14 = [None] * len(bdates)
    for i in range(14, len(bdates)):
        atr14[i] = sum(tr[i - 13:i + 1]) / 14

    # option volume on the two legs the strategy would sell
    def legvol(d, floor=15):
        v = 0.0
        for cp in 'CP':
            l = pick_floor(d, cp, floor)
            if l:
                v += l['vol_8h']
        return v

    vols = {d['date']: legvol(d) for d in days}
    vlist = sorted(v for v in vols.values() if v > 0)
    vmed = vlist[len(vlist) // 2] if vlist else 0

    def feat(dt):
        """Everything known BEFORE the 05:30 entry: the prior day's bar."""
        i = idx.get(dt)
        if i is None or i < 30:
            return None
        p = i - 1                                  # yesterday's completed bar
        return {
            'ret24': 100 * (closes[p] - closes[p - 1]) / closes[p - 1],
            'trend': 1 if e9[p] > e21[p] else -1 if e9[p] < e21[p] else 0,
            'rsi': rsi[p],
            'macd_up': (macd[p] - sig[p]) > 0,
            'macd_hist': macd[p] - sig[p],
            'atr_pct': 100 * atr14[p] / closes[p] if atr14[p] else None,
            'vol': vols.get(dt, 0),
        }

    def backtest(rule, floor=15, sub=None):
        rows = []
        for dt in (sub or dates):
            d = by[dt]
            f = feat(dt)
            if f is None:
                continue
            wc, wp = rule(f)
            if wc == 0 and wp == 0:
                continue                            # rule says stand aside
            lc, lp = pick_floor(d, 'C', floor), pick_floor(d, 'P', floor)
            if not lc or not lp:
                continue
            rows.append({'date': dt, 'pnl':
                (lc['mark'] * (1 - SLIP) - lc['settle_value']) * TOT * wc * LOT +
                (lp['mark'] * (1 - SLIP) - lp['settle_value']) * TOT * wp * LOT})
        return stats(rows)

    W = 0.7
    flat = lambda f: (0.5, 0.5)
    candidates = {
        'baseline flat 50/50': flat,
        # --- filters: stand aside when the signal fires
        'skip RSI > 70': lambda f: (0, 0) if (f['rsi'] or 50) > 70 else (0.5, 0.5),
        'skip RSI < 30': lambda f: (0, 0) if (f['rsi'] or 50) < 30 else (0.5, 0.5),
        'skip RSI outside 30-70': lambda f: (0, 0) if not (30 <= (f['rsi'] or 50) <= 70) else (0.5, 0.5),
        'skip high ATR (>4%)': lambda f: (0, 0) if (f['atr_pct'] or 0) > 4 else (0.5, 0.5),
        'skip low ATR (<2%)': lambda f: (0, 0) if (f['atr_pct'] or 9) < 2 else (0.5, 0.5),
        'skip |24h| > 4%': lambda f: (0, 0) if abs(f['ret24']) > 4 else (0.5, 0.5),
        'skip thin option volume': lambda f: (0, 0) if f['vol'] < vmed * 0.5 else (0.5, 0.5),
        # --- skews: lean the split when the signal fires
        'skew by MACD': lambda f: (1 - W, W) if f['macd_up'] else (W, 1 - W),
        'skew by RSI 50': lambda f: (1 - W, W) if (f['rsi'] or 50) > 50 else (W, 1 - W),
        'skew by daily trend': lambda f: (1 - W, W) if f['trend'] > 0 else ((W, 1 - W) if f['trend'] < 0 else (0.5, 0.5)),
        'skew: 24h + trend (live)': lambda f: (1 - W, W) if (f['ret24'] > 2 or (f['ret24'] > 0 and f['trend'] > 0))
            else ((W, 1 - W) if (f['ret24'] < -2 or (f['ret24'] < 0 and f['trend'] < 0)) else (0.5, 0.5)),
        'skew: MACD + 24h': lambda f: (1 - W, W) if (f['macd_up'] and f['ret24'] > 0)
            else ((W, 1 - W) if (not f['macd_up'] and f['ret24'] < 0) else (0.5, 0.5)),
    }

    print('=' * 116)
    print('  INDICATOR SCREEN — full period, $15 floor, 10 lots, 5% slippage')
    print('=' * 116)
    base = backtest(flat)
    for name, rule in candidates.items():
        s = backtest(rule)
        mark = ''
        if s and base and name != 'baseline flat 50/50':
            better = s['pf'] > base['pf'] and s['total'] / max(s['mdd'], 1e-9) > base['total'] / max(base['mdd'], 1e-9)
            mark = '  <-- better on both' if better else ''
        print('  ' + row(name, s, width=26) + mark)

    print()
    print('=' * 116)
    print('  PER YEAR — only rules that improved on both measures above')
    print('=' * 116)
    survivors = [n for n, r in candidates.items()
                 if n != 'baseline flat 50/50'
                 and (lambda s: s and s['pf'] > base['pf']
                      and s['total'] / max(s['mdd'], 1e-9) > base['total'] / max(base['mdd'], 1e-9))(backtest(r))]
    if not survivors:
        print('  none')
    for name in survivors:
        print(f'\n  {name}')
        for y in ('2024', '2025', '2026'):
            sub = [d for d in dates if d.startswith(y)]
            print('    ' + row('baseline', backtest(flat, sub=sub), width=12))
            print('    ' + row(name[:12], backtest(candidates[name], sub=sub), width=12))
            print()


if __name__ == '__main__':
    main()
