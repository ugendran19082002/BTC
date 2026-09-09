#!/usr/bin/env python3
"""Gating the baseline on how likely the leg is to expire worthless.

The strategy as it stands: 05:30 IST, sell the furthest strike that still pays at least $15,
buy back at 95% decay, otherwise let it settle. This asks whether refusing the
legs that are not safe enough makes it better.

Two different bars, and they are not the same question:

  MODEL      the option's own risk-neutral probability of finishing worthless,
             N(-d2) for a call and N(d2) for a put, at the implied vol solved
             from that leg's own quoted mark. What the maths says.

  SYSTEM 0%  what actually happened to legs the model scored the same way. Every
             quoted leg in chain.db is bucketed by model probability and the
             observed share that settled at zero is measured. What the record
             says.

The distinction matters because the two disagree, and the direction of the
disagreement is the whole reason `domain/calibration.ts` exists. chain.db's own
calibration table stops at a single 0.95-1.0 bucket, which cannot answer a
question asked at 99% and 98.5%, so the buckets here are cut finer.

Each bar is applied three ways -- to the call, to the put, and to both -- since
a gate that helps one side need not help the other.

Everything is measured. Marks, strikes, settlements and decay paths all come
out of chain.db.

  python3 research/probability_gates.py
"""
import datetime, json, math, os, sqlite3, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
OUT = os.path.join(HERE, 'PROBABILITY-GATES.txt')

CONTRACTS, CV, SLIP, USDINR = 10, 0.001, 0.05, 85
T12 = 12 / 24 / 365
TARGET = 0.05                      # 95% decay
# Fine buckets where the question actually lives.
EDGES = [0.90, 0.95, 0.97, 0.98, 0.985, 0.99, 0.995, 1.0001]


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
    if p <= max(0.0, (s - k) if cp == 'C' else (k - s)) or p <= 0:
        return None
    lo, hi = 0.03, 5.0
    for _ in range(100):
        m = (lo + hi) / 2
        if bs(cp, s, k, t, m) < p:
            lo = m
        else:
            hi = m
    return (lo + hi) / 2


def p_worthless(cp, s, k, t, v):
    """N(-d2) for a call, N(d2) for a put -- probability.ts, exactly."""
    if not (t > 0 and v > 0 and s > 0 and k > 0):
        return None
    sq = v * math.sqrt(t)
    d2 = (math.log(s / k) + 0.5 * v * v * t) / sq - sq
    return cdf(-d2) if cp == 'C' else cdf(d2)


def bucket_of(p):
    for i in range(len(EDGES) - 1):
        if EDGES[i] <= p < EDGES[i + 1]:
            return i
    return None if p < EDGES[0] else len(EDGES) - 2


def main():
    con = sqlite3.connect(CHAIN)
    L = []
    w = L.append

    # ---- calibration, from every quoted leg -----------------------------
    allrows = con.execute("""SELECT d.spot, l.cp, l.k, l.mark, l.settle_value
                             FROM legs l JOIN days d ON d.date = l.date
                             WHERE l.mark > 0 AND d.spot > 0
                               AND l.settle_value IS NOT NULL""").fetchall()
    buckets = {i: [0, 0] for i in range(len(EDGES) - 1)}
    for spot, cp, k, mark, sv in allrows:
        v = solve_iv(cp, spot, k, T12, mark)
        if v is None:
            continue
        p = p_worthless(cp, spot, k, T12, v)
        b = bucket_of(p) if p is not None else None
        if b is None:
            continue
        buckets[b][0] += 1
        buckets[b][1] += 1 if sv == 0 else 0
    observed = {i: (n and z / n) for i, (n, z) in buckets.items()}

    w('=' * 88)
    w('PROBABILITY GATES ON THE BASELINE')
    w('=' * 88)
    w('Baseline: 05:30 IST, furthest strike that still pays at least $15, buy back at 95% decay.')
    w(f'{CONTRACTS} contracts per leg, {SLIP*100:.0f}% slippage. All figures measured from chain.db.')
    w('')
    w('=' * 88)
    w('CALIBRATION -- what the model says against what actually happened')
    w('=' * 88)
    w(f'  {"MODEL P(worthless)":<22} {"LEGS":>7} {"EXPIRED 0":>10} {"ACTUAL":>9} {"MODEL-ACTUAL":>13}')
    for i in range(len(EDGES) - 1):
        n, z = buckets[i]
        if n < 30:
            continue
        mid = (EDGES[i] + min(EDGES[i + 1], 1.0)) / 2
        act = z / n
        w(f'  {EDGES[i]*100:>5.1f}% - {min(EDGES[i+1],1.0)*100:>5.1f}%       {n:>7,} {z:>10,} '
          f'{act*100:>8.2f}% {(mid-act)*100:>+12.2f}')
    w('')
    w('  A positive last column is the model claiming more safety than the record')
    w('  delivered. This is what `domain/calibration.ts` corrects for, and it is')
    w('  why a 99% model reading and a 99% observed rate are different bars.')
    w('')

    # ---- the selected legs ----------------------------------------------
    rows = con.execute("""SELECT p.date, p.cp, p.k, p.entry, p.decay, l.settle_value, d.spot
                          FROM paths p
                          JOIN legs l ON l.date=p.date AND l.cp=p.cp AND l.k=p.k
                          JOIN days d ON d.date=p.date
                          WHERE p.floor=15.0 AND p.entry>0""").fetchall()
    legs = {}
    for date, cp, k, entry, dj, sv, spot in rows:
        v = solve_iv(cp, spot, k, T12, entry)
        p = p_worthless(cp, spot, k, T12, v) if v else None
        b = bucket_of(p) if p is not None else None
        d = json.loads(dj or '{}')
        credit = entry * (1 - SLIP)
        hit = d.get(str(TARGET)) is not None
        pnl = money(credit - (entry * TARGET * (1 + SLIP) if hit else (sv or 0.0)))
        legs.setdefault(date, {})[cp] = {
            'pnl': pnl, 'model': p, 'obs': observed.get(b) if b is not None else None,
            'zero': (sv == 0),
        }
    dates = sorted(d for d in legs if len(legs[d]) == 2)

    def score(gate, sides):
        """gate(leg)->bool; sides says which legs may be sold."""
        out, sold = {}, 0
        for d in dates:
            tot = 0.0
            for cp in sides:
                L2 = legs[d][cp]
                if gate(L2):
                    tot += L2['pnl']
                    sold += 1
            out[d] = tot
        return out, sold

    def stats(series):
        v = [series[d] for d in dates]
        traded = [x for x in v if x != 0]
        wins = [x for x in traded if x > 0]
        gl = -sum(x for x in traded if x <= 0)
        eq = peak = mdd = 0.0
        for x in v:
            eq += x
            peak = max(peak, eq)
            mdd = max(mdd, peak - eq)
        return (sum(v), len(traded), (len(wins) / len(traded) * 100) if traded else 0,
                min(v), mdd, (sum(wins) / gl) if gl else float('inf'))

    def table(title, keyfn, bars):
        w('=' * 88)
        w(title)
        w('=' * 88)
        w(f'  {"GATE":<14} {"LEGS":<6} {"SOLD":>6} {"DAYS":>5} {"TOTAL Rs":>10} {"WIN%":>6} '
          f'{"PF":>6} {"WORST Rs":>9} {"MDD Rs":>8}')
        w('  ' + '-' * 78)
        for bar_label, bar in bars:
            for side_label, sides in (('CE', ('C',)), ('PE', ('P',)), ('both', ('C', 'P'))):
                if bar is None:
                    g = lambda L2: True                                    # noqa: E731
                else:
                    g = lambda L2, b=bar: (keyfn(L2) is not None and keyfn(L2) >= b)  # noqa: E731
                s, sold = score(g, sides)
                tot, nd, win, worst, mdd, pf = stats(s)
                w(f'  {bar_label:<14} {side_label:<6} {sold:>6} {nd:>5} {tot*USDINR:>+10,.0f} '
                  f'{win:>5.1f}% {pf:>6.2f} {worst*USDINR:>+9,.0f} {mdd*USDINR:>8,.0f}')
            w('')

    table('NO GATE -- the baseline as it runs today',
          lambda L2: L2['model'], [('none', None)])
    table('GATE ON MODEL PROBABILITY   (what the maths says)',
          lambda L2: L2['model'], [('model >= 99%', 0.99), ('model >= 98.5%', 0.985)])
    table('GATE ON SYSTEM 0% RATE      (what the record says)',
          lambda L2: L2['obs'], [('actual >= 99%', 0.99), ('actual >= 98.5%', 0.985)])

    # ---- does it hold up -------------------------------------------------
    w('=' * 88)
    w('OUT OF SAMPLE -- first half against second')
    w('=' * 88)
    half = len(dates) // 2
    parts = [('first', dates[:half]), ('second', dates[half:])]
    w(f'  {"GATE":<16} {"LEGS":<6} {"1st half Rs":>12} {"2nd half Rs":>12} {"both +ve?":>10}')
    w('  ' + '-' * 62)
    for label, keyfn, bar in (
        ('no gate', lambda L2: 1.0, 0.0),
        ('model >= 99%', lambda L2: L2['model'], 0.99),
        ('model >= 98.5%', lambda L2: L2['model'], 0.985),
        ('actual >= 99%', lambda L2: L2['obs'], 0.99),
        ('actual >= 98.5%', lambda L2: L2['obs'], 0.985),
    ):
        for side_label, sides in (('CE', ('C',)), ('PE', ('P',)), ('both', ('C', 'P'))):
            g = lambda L2, b=bar, f=keyfn: (f(L2) is not None and f(L2) >= b)   # noqa: E731
            tots = []
            for _, part in parts:
                t = 0.0
                for d in part:
                    for cp in sides:
                        if g(legs[d][cp]):
                            t += legs[d][cp]['pnl']
                tots.append(t)
            ok = 'yes' if tots[0] > 0 and tots[1] > 0 else 'NO'
            w(f'  {label:<16} {side_label:<6} {tots[0]*USDINR:>+12,.0f} {tots[1]*USDINR:>+12,.0f} {ok:>10}')
        w('')

    # ---- honest out of sample: calibrate on half one, trade half two ------
    w('=' * 88)
    w('CALIBRATED ON THE FIRST HALF, TRADED ON THE SECOND')
    w('=' * 88)
    w('  The table above still had one thread of hindsight in it: the bucket rates')
    w('  were measured over the whole record, including the days they then judged.')
    w('  Here the buckets are built from the first half alone and never updated.')
    w('')
    cut = dates[half]
    b2 = {i: [0, 0] for i in range(len(EDGES) - 1)}
    for date, cp, k, mark, sv in con.execute(
            """SELECT l.date, l.cp, l.k, l.mark, l.settle_value FROM legs l
               JOIN days d ON d.date=l.date
               WHERE l.mark>0 AND d.spot>0 AND l.settle_value IS NOT NULL AND l.date < ?""",
            (cut,)):
        spot = con.execute('SELECT spot FROM days WHERE date=?', (date,)).fetchone()[0]
        v = solve_iv(cp, spot, k, T12, mark)
        if v is None:
            continue
        p = p_worthless(cp, spot, k, T12, v)
        b = bucket_of(p) if p is not None else None
        if b is None:
            continue
        b2[b][0] += 1
        b2[b][1] += 1 if sv == 0 else 0
    obs1 = {i: (n and z / n) for i, (n, z) in b2.items()}

    w(f'  {"GATE":<16} {"LEGS":<6} {"SOLD":>6} {"TOTAL Rs":>10} {"WIN%":>6} {"PF":>6} {"WORST Rs":>9}')
    w('  ' + '-' * 64)
    second = dates[half:]
    for label, bar in (('no gate', None), ('actual >= 99%', 0.99), ('actual >= 98.5%', 0.985)):
        for side_label, sides in (('CE', ('C',)), ('PE', ('P',)), ('both', ('C', 'P'))):
            vals, sold = [], 0
            for d in second:
                t = 0.0
                for cp in sides:
                    Lg = legs[d][cp]
                    bk = bucket_of(Lg['model']) if Lg['model'] is not None else None
                    r = obs1.get(bk) if bk is not None else None
                    if bar is None or (r is not None and r >= bar):
                        t += Lg['pnl']
                        sold += 1
                vals.append(t)
            traded = [x for x in vals if x != 0]
            wins = [x for x in traded if x > 0]
            gl = -sum(x for x in traded if x <= 0)
            pf = (sum(wins) / gl) if gl else float('inf')
            wr = (len(wins) / len(traded) * 100) if traded else 0
            w(f'  {label:<16} {side_label:<6} {sold:>6} {sum(vals)*USDINR:>+10,.0f} '
              f'{wr:>5.1f}% {pf:>6.2f} {(min(vals) if vals else 0)*USDINR:>+9,.0f}')
        w('')

    # ---- the fair comparison: same risk, not same size --------------------
    w('=' * 88)
    w('AT EQUAL RISK -- each variant sized so its drawdown matches the baseline')
    w('=' * 88)
    w('  Gating trades fewer days, so comparing raw totals compares two different')
    w('  amounts of risk. Scaling each to the baseline\'s Rs 1,943 drawdown asks')
    w('  the question that matters: for the same worst stretch, what comes back?')
    w('')
    base_s, _ = score(lambda L2: True, ('C', 'P'))
    base_tot, _, _, _, base_mdd, _ = stats(base_s)
    w(f'  {"GATE":<16} {"LEGS":<6} {"SIZE x":>7} {"TOTAL Rs":>11} {"vs BASE":>9}')
    w('  ' + '-' * 54)
    for label, keyfn, bar in (('no gate', lambda L2: 1.0, 0.0),
                              ('actual >= 99%', lambda L2: L2['obs'], 0.99),
                              ('actual >= 98.5%', lambda L2: L2['obs'], 0.985)):
        for side_label, sides in (('CE', ('C',)), ('PE', ('P',)), ('both', ('C', 'P'))):
            g = lambda L2, b=bar, f=keyfn: (f(L2) is not None and f(L2) >= b)   # noqa: E731
            s, _ = score(g, sides)
            tot, _, _, _, mdd, _ = stats(s)
            if mdd <= 0:
                continue
            scale = base_mdd / mdd
            w(f'  {label:<16} {side_label:<6} {scale:>6.2f}x {tot*scale*USDINR:>+11,.0f} '
              f'{(tot*scale/base_tot-1)*100:>+8.0f}%')
        w('')
    w('  Scaling assumes the shape of the record repeats, which is the assumption')
    w('  every one of these tables makes. It is a comparison, not a promise.')
    w('=' * 88)

    text = '\n'.join(L) + '\n'
    open(OUT, 'w').write(text)
    print(text)
    print(f'wrote -> {OUT}')


if __name__ == '__main__':
    main()
