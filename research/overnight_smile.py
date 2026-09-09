#!/usr/bin/env python3
"""The overnight trade, priced on the smile the market actually quotes.

The earlier sweep priced every option at one flat 36.8% implied vol and found
24 losing configurations. That was a fact about the model. Real daily BTC
options are not quoted flat -- 30,000 legs in chain.db price the wings far
above the money:

    at the money   29%          3.5% out   45%
    2% out         37%          5.0% out   53%
    3% out         43%          8.0% out   77%

A flat 36.8% therefore *overprices* the near strikes and badly *underprices*
the far ones. Since the strike is chosen by premium, underpricing the wings
puts every strike too close to spot, and the model then loses money it was
always going to lose.

This rebuilds it on the measured smile.

The smile is indexed by standardised moneyness

    m = ln(K/S) / sqrt(T)

rather than by raw distance, so it can be carried from the 12-hour contract it
was measured on to the 18-hour one the overnight trade sells without pretending
a 3% strike means the same thing at both. Between the measured points it
interpolates linearly and beyond them it holds the end value rather than
extrapolating a curve nobody measured.

STILL MODELLED. There are no recorded option quotes at 23:30 IST. What changes
here is that the pricing now matches the market's own shape instead of a flat
line, so the strike selection is defensible. The exit path is still
Black-Scholes on the real spot path, and only a real 23:30 snapshot in
harvest_chain.py can settle the question properly.

  python3 research/overnight_smile.py
"""
import datetime, json, math, os, sqlite3, statistics as st, zoneinfo

IST = zoneinfo.ZoneInfo('Asia/Kolkata')
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
CACHE = os.path.join(HERE, 'cache-5m.json')
OUT = os.path.join(HERE, 'OVERNIGHT-REPORT.txt')

CONTRACTS, CV, SLIP, USDINR = 10, 0.001, 0.05, 85
CLOSE_STEP = 66                      # 05:00 IST, in 5-minute steps from 23:30


def money(q):
    return q * CONTRACTS * CV


def cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(cp, s, k, t, v):
    if t <= 0 or v <= 0:
        return max(0.0, (s - k) if cp == 'C' else (k - s))
    d1 = (math.log(s / k) + 0.5 * v * v * t) / (v * math.sqrt(t))
    d2 = d1 - v * math.sqrt(t)
    return s * cdf(d1) - k * cdf(d2) if cp == 'C' else k * cdf(-d2) - s * cdf(-d1)


def solve_iv(cp, s, k, t, p):
    if p <= max(0.0, (s - k) if cp == 'C' else (k - s)):
        return None
    lo, hi = 0.05, 4.0
    for _ in range(120):
        m = (lo + hi) / 2
        if bs(cp, s, k, t, m) < p:
            lo = m
        else:
            hi = m
    return (lo + hi) / 2


def build_smile():
    """Median IV by standardised moneyness, from every real quoted leg."""
    con = sqlite3.connect(CHAIN)
    rows = con.execute("""SELECT d.spot, l.cp, l.k, l.mark FROM legs l
                          JOIN days d ON d.date = l.date
                          WHERE l.mark > 0.5 AND d.spot > 0""").fetchall()
    T = 12 / 24 / 365
    buckets = {}
    for spot, cp, k, mark in rows:
        otm = (k - spot) / spot if cp == 'C' else (spot - k) / spot
        if otm <= 0:
            continue
        v = solve_iv(cp, spot, k, T, mark)
        if v is None or v > 3:
            continue
        m = abs(math.log(k / spot)) / math.sqrt(T)
        buckets.setdefault(round(m, 1), []).append(v)
    pts = sorted((m, st.median(v)) for m, v in buckets.items() if len(v) >= 30)
    return pts


def smile_iv(pts, m):
    m = abs(m)
    if m <= pts[0][0]:
        return pts[0][1]
    if m >= pts[-1][0]:
        return pts[-1][1]
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        if a[0] <= m <= b[0]:
            w = (m - a[0]) / (b[0] - a[0])
            return a[1] + w * (b[1] - a[1])
    return pts[-1][1]


def price(pts, cp, s, k, t):
    """Black-Scholes at the vol the smile puts on this strike and tenor."""
    if t <= 0:
        return max(0.0, (s - k) if cp == 'C' else (k - s))
    return bs(cp, s, k, t, smile_iv(pts, math.log(k / s) / math.sqrt(t)))


def pick(pts, cp, s, t, cap):
    base = int(s / 200) * 200
    last = None
    for j in range(220):
        k = base + j * 200 if cp == 'C' else base - j * 200
        if k <= 0:
            break
        p = price(pts, cp, s, k, t)
        if p <= cap:
            return k, p
        last = (k, p)
    return last


def walk(pts, caps):
    bars = {int(t): b for t, b in json.load(open(CACHE)).items()}
    slot = {}
    for t, b in bars.items():
        d = datetime.datetime.fromtimestamp(t, IST)
        slot[(d.date(), d.hour, d.minute - d.minute % 5)] = b['close']
    dates = sorted({d for d, _, _ in slot})
    rec = {c: {} for c in caps}
    for i, d in enumerate(dates[:-1]):
        nxt = dates[i + 1]
        if (nxt - d).days != 1:
            continue
        s0, s_end = slot.get((d, 23, 30)), slot.get((nxt, 17, 30))
        if s0 is None or s_end is None:
            continue
        for cap in caps:
            legs, ok = [], True
            for cp in ('C', 'P'):
                got = pick(pts, cp, s0, 18 / 24 / 365, cap)
                if got is None or got[1] <= 0:
                    ok = False
                    break
                k, entry = got
                first, at_close = {}, None
                for step in range(1, 217):
                    mins = step * 5
                    hh, mm = divmod((23 * 60 + 30 + mins) % 1440, 60)
                    dd = d if (23 * 60 + 30 + mins) < 1440 else nxt
                    s = slot.get((dd, hh, mm - mm % 5))
                    if s is None:
                        continue
                    val = price(pts, cp, s, k, max((18 * 60 - mins) / 60 / 24 / 365, 0))
                    for f in (0.3, 0.5, 0.1):
                        if f not in first and val <= entry * f:
                            first[f] = step
                    if step == CLOSE_STEP:
                        at_close = val
                if at_close is None:
                    ok = False
                    break
                legs.append({'entry': entry, 'k': k, 'otm': abs(k - s0) / s0 * 100,
                             'first': first, 'close': at_close,
                             'settle': max(0.0, (s_end - k) if cp == 'C' else (k - s_end))})
            if ok:
                rec[cap][str(nxt)] = legs
    return rec


def score(byday, frac, mode):
    out, hit, tot = {}, 0, 0
    for date, legs in byday.items():
        day = 0.0
        for L in legs:
            tot += 1
            credit = L['entry'] * (1 - SLIP)
            step = L['first'].get(frac)
            if step is not None and (mode == 'hold' or step <= CLOSE_STEP):
                hit += 1
                ex = L['entry'] * frac * (1 + SLIP)
            elif mode == 'window':
                ex = L['close'] * (1 + SLIP)
            else:
                ex = L['settle']
            day += money(credit - ex)
        out[date] = day
    return out, hit / max(tot, 1)


def stats(series, dates):
    v = [series[d] for d in dates]
    wins = [x for x in v if x > 0]
    gl = -sum(x for x in v if x <= 0)
    eq = peak = mdd = 0.0
    for x in v:
        eq += x
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)
    return (sum(v), st.fmean(v), len(wins) / len(v) * 100, min(v), mdd,
            (sum(wins) / gl) if gl else float('inf'))


def real_day(frac):
    con = sqlite3.connect(CHAIN)
    rows = con.execute("""SELECT p.date,p.cp,p.entry,p.decay,l.settle_value FROM paths p
                          JOIN legs l ON l.date=p.date AND l.cp=p.cp AND l.k=p.k
                          WHERE p.floor=15.0 AND p.entry>0""").fetchall()
    out = {}
    for date, cp, entry, dj, settle in rows:
        d = json.loads(dj or '{}')
        credit = entry * (1 - SLIP)
        r = d.get(str(frac))
        pnl = credit - (entry * frac * (1 + SLIP) if r is not None else (settle or 0.0))
        out[date] = out.get(date, 0.0) + money(pnl)
    return out


def main():
    L = []
    w = L.append
    pts = build_smile()
    caps = [10, 15, 30]
    rec = walk(pts, caps)
    day95 = real_day(0.05)
    dates = sorted(set.intersection(*[set(rec[c]) for c in caps]) & set(day95))

    w('=' * 84)
    w('OVERNIGHT 23:30 -> 05:00, PRICED ON THE REAL VOLATILITY SMILE')
    w('=' * 84)
    w(f'Days            {len(dates):,}   ({dates[0]} to {dates[-1]})')
    w(f'Size            {CONTRACTS} contracts per leg, CE + PE, {SLIP*100:.0f}% slippage')
    w('')
    w('THE SMILE, measured from every quoted leg in chain.db')
    w('  m = ln(K/S)/sqrt(T), so it carries across tenors')
    w(f'  {"m":>6}  {"IV":>7}   (12h contract, ~2.7% out is m=0.7)')
    for m, v in pts:
        w(f'  {m:>6.1f}  {v*100:>6.1f}%')
    w('')
    w('  The earlier flat 36.8% sat above the near strikes and far below the far')
    w('  ones. Because the strike is picked by premium, underpricing the wings put')
    w('  every strike too close to spot -- which is what produced 24 losing rows.')
    w('')
    w('=' * 84)
    w('RESULTS')
    w('=' * 84)
    w(f'  {"CAP":>4} {"TGT":>5} {"MODE":>7} {"OTM":>7} {"HIT":>6} {"TOTAL Rs":>10} '
      f'{"/DAY":>7} {"WIN%":>6} {"WORST":>8} {"MAXDD":>8} {"PF":>5}')
    w('  ' + '-' * 80)
    best = []
    for cap in caps:
        otm = st.fmean([l['otm'] for legs in rec[cap].values() for l in legs])
        for frac, lab in ((0.3, '70%'), (0.5, '50%'), (0.1, '90%')):
            for mode in ('window', 'hold'):
                s, h = score(rec[cap], frac, mode)
                t, a, win, worst, mdd, pf = stats(s, dates)
                best.append((t, cap, lab, mode))
                w(f'  {"$"+str(cap):>4} {lab:>5} {mode:>7} {otm:>6.2f}% {h*100:>5.1f}% '
                  f'{t*USDINR:>+10,.0f} {a*USDINR:>+7.2f} {win:>5.1f}% '
                  f'{worst*USDINR:>+8,.0f} {mdd*USDINR:>8,.0f} {pf:>5.2f}')
        w('')

    dt, da, dwin, dworst, dmdd, dpf = stats(day95, dates)
    w('  THE DAY TRADE, for comparison -- REAL data, no model anywhere')
    w(f'  {"$15":>4} {"95%":>5} {"real":>7} {"":>7} {"":>6} {dt*USDINR:>+10,.0f} '
      f'{da*USDINR:>+7.2f} {dwin:>5.1f}% {dworst*USDINR:>+8,.0f} {dmdd*USDINR:>8,.0f} {dpf:>5.2f}')
    w('')
    w('=' * 84)
    w('BEST OVERNIGHT VARIANTS')
    w('=' * 84)
    for t, cap, lab, mode in sorted(best, reverse=True)[:5]:
        w(f'  ${cap} cap, {lab} target, {mode:<6}   Rs {t*USDINR:+,.0f}')
    w('')
    w('=' * 84)
    w('WHAT THIS DOES AND DOES NOT SETTLE')
    w('=' * 84)
    w('  Pricing now matches the market\'s own shape, so the strike selection is')
    w('  defensible in a way the flat-vol sweep was not. What has not changed:')
    w('  there are still no recorded option quotes at 23:30 IST. The entry price,')
    w('  the exit price and every step between are computed, not observed.')
    w('')
    w('  The day trade needs no such disclaimer. Its entry marks, settle values and')
    w('  decay paths are all read from chain.db.')
    w('')
    w('  To settle the overnight question the way the day trade is settled, add a')
    w('  23:30 IST snapshot to harvester/harvest_chain.py and wait.')
    w('=' * 84)

    text = '\n'.join(L) + '\n'
    open(OUT, 'w').write(text)
    print(text)
    print(f'wrote -> {OUT}')


if __name__ == '__main__':
    main()
