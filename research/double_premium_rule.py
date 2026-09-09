#!/usr/bin/env python3
"""DOUBLE under the two premium rules: at least $15, or at most $15.

They sound like the same setting and they are opposites.

  >= $15   the FURTHEST strike still paying $15. Richer premium, and because a
           richer premium means a nearer strike, more risk. This is what the
           `paths` table selected and what every figure in FINAL-COMPARISON.txt
           was measured on.

  <= $15   the RICHEST strike at or below $15. Cheaper premium, further strike,
           less risk. AlgoTest's `Premium <= 15`, and the rule the README
           describes.

Both are scored here with the same gate, the same doubling rule and the same
exit, so the only thing that differs is which strike gets sold.

HELD TO SETTLEMENT, both of them. chain.db records an intraday decay path only
for the legs the >= $15 floor selected, so a <= $15 strike has no path and the
95% target cannot be applied to it. Holding both to settlement is the only
like-for-like comparison available; on the >= $15 rule the target was worth
about 4% on top, and there is no reason to think it differs much on the other.

  python3 research/double_premium_rule.py
"""
import datetime, json, math, os, sqlite3, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
OUT = os.path.join(HERE, 'DOUBLE-PREMIUM-RULE.txt')

CONTRACTS, CV, SLIP, USDINR = 10, 0.001, 0.05, 85
T12, GATE = 12 / 24 / 365, 0.95
EQUITY_INR = 39_700


def money(q, lots=1):
    return q * CONTRACTS * lots * CV


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
    sq = v * math.sqrt(t)
    d2 = (math.log(s / k) + 0.5 * v * v * t) / sq - sq
    return cdf(-d2) if cp == 'C' else cdf(d2)


def stats(vals):
    traded = [x for x in vals if x != 0]
    wins = [x for x in traded if x > 0]
    gl = -sum(x for x in traded if x <= 0)
    eq = peak = mdd = 0.0
    for x in vals:
        eq += x
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)
    return {
        'total': sum(vals), 'days': len(traded),
        'win': (len(wins) / len(traded) * 100) if traded else 0,
        'pf': (sum(wins) / gl) if gl else float('inf'),
        'worst': min(vals) if vals else 0, 'mdd': mdd,
        'losers': len(traded) - len(wins),
    }


def main():
    con = sqlite3.connect(CHAIN)
    days = {d: (spot, settle) for d, spot, settle in
            con.execute('SELECT date,spot,settle FROM days WHERE settle IS NOT NULL')}
    chain = {}
    for date, cp, k, mark, sv in con.execute(
            'SELECT date,cp,k,mark,settle_value FROM legs WHERE mark>0'):
        chain.setdefault(date, {}).setdefault(cp, []).append(
            {'k': k, 'mark': mark, 'sv': sv or 0.0})

    # probability and distance for every OTM candidate
    cand = {}
    for date, sides in chain.items():
        if date not in days:
            continue
        spot, _ = days[date]
        for cp, rows in sides.items():
            keep = []
            for r in rows:
                otm = (r['k'] - spot) if cp == 'C' else (spot - r['k'])
                if otm <= 0:
                    continue
                v = solve_iv(cp, spot, r['k'], T12, r['mark'])
                if v is None:
                    continue
                keep.append({**r, 'p': p_worthless(cp, spot, r['k'], T12, v),
                             'otm': otm / spot * 100})
            if keep:
                cand.setdefault(date, {})[cp] = keep
    dates = sorted(d for d in cand if len(cand[d]) == 2)

    def pick(date, cp, mode, floor=15.0):
        rows = cand[date][cp]
        if mode == 'atLeast':
            ok = [r for r in rows if r['mark'] >= floor]
            # furthest strike still paying the floor
            return max(ok, key=lambda r: r['otm']) if ok else None
        ok = [r for r in rows if r['mark'] <= floor]
        # richest strike at or below the cap
        return max(ok, key=lambda r: r['mark']) if ok else None

    def run(mode, gate, doubling):
        vals, lots_sold, prem, otm, zeros, legs_sold = [], 0, [], [], 0, 0
        onesided = 0
        for d in dates:
            chosen = {}
            for cp in ('C', 'P'):
                r = pick(d, cp, mode)
                if r and (not gate or r['p'] >= GATE):
                    chosen[cp] = r
            if len(chosen) == 1:
                onesided += 1
            t = 0.0
            for cp, r in chosen.items():
                n = 2 if (doubling and gate and len(chosen) == 1) else 1
                t += money(r['mark'] * (1 - SLIP) - r['sv'], n)
                lots_sold += n
                legs_sold += 1
                prem.append(r['mark'])
                otm.append(r['otm'])
                zeros += 1 if r['sv'] == 0 else 0
            vals.append(t)
        s = stats(vals)
        s.update(lots=lots_sold, legs=legs_sold, onesided=onesided,
                 prem=st.fmean(prem) if prem else 0, otm=st.fmean(otm) if otm else 0,
                 acc=(zeros / legs_sold * 100) if legs_sold else 0, vals=vals)
        return s

    L = []
    w = L.append
    w('=' * 88)
    w('DOUBLE:  PREMIUM >= $15  vs  PREMIUM <= $15')
    w('=' * 88)
    w(f'  {len(dates):,} days, {dates[0]} to {dates[-1]}.  {CONTRACTS} contracts per lot,')
    w(f'  {SLIP*100:.0f}% slippage, 95% gate per leg, doubling on, HELD TO SETTLEMENT.')
    w('')
    w('  >= $15   furthest strike still paying $15   -- richer premium, nearer strike')
    w('  <= $15   richest strike at or below $15     -- cheaper premium, further strike')
    w('')

    ge = run('atLeast', True, True)
    le = run('atMost', True, True)
    ge_ng = run('atLeast', False, False)
    le_ng = run('atMost', False, False)

    w(f'  {"":<24} {">= $15":>13} {"<= $15":>13} {"DIFFERENCE":>14}')
    w('  ' + '-' * 68)
    rows = [
        ('legs sold', 'legs', '{:,.0f}', 1),
        ('lots sold', 'lots', '{:,.0f}', 1),
        ('days traded', 'days', '{:,.0f}', 1),
        ('one-sided days', 'onesided', '{:,.0f}', 1),
        ('avg premium sold', 'prem', '${:.2f}', 1),
        ('avg distance out', 'otm', '{:.2f}%', 1),
        ('actual expired at 0', 'acc', '{:.2f}%', 1),
        ('TOTAL Rs', 'total', '{:+,.0f}', USDINR),
        ('win rate', 'win', '{:.1f}%', 1),
        ('profit factor', 'pf', '{:.2f}', 1),
        ('losing days', 'losers', '{:,.0f}', 1),
        ('worst day Rs', 'worst', '{:+,.0f}', USDINR),
        ('max drawdown Rs', 'mdd', '{:,.0f}', USDINR),
    ]
    for label, key, fmt, mul in rows:
        a, b = ge[key] * mul, le[key] * mul
        diff = ''
        if key in ('total', 'pf', 'worst', 'mdd', 'lots'):
            diff = f'{(b - a) / abs(a) * 100:+.0f}%' if a else '--'
        w(f'  {label:<24} {fmt.format(a):>13} {fmt.format(b):>13} {diff:>14}')
    w('')

    w('=' * 88)
    w('THE SAME TWO RULES WITH NO GATE AND NO DOUBLING')
    w('=' * 88)
    w('  So the premium rule can be judged on its own, before the gate is added.')
    w('')
    w(f'  {"":<24} {">= $15":>13} {"<= $15":>13}')
    for label, key, fmt, mul in rows:
        w(f'  {label:<24} {fmt.format(ge_ng[key]*mul):>13} {fmt.format(le_ng[key]*mul):>13}')
    w('')

    w('=' * 88)
    w('OUT OF SAMPLE')
    w('=' * 88)
    half = len(dates) // 2
    w(f'  {"":<20} {"1st half Rs":>12} {"2nd half Rs":>12} {"PF 1st":>8} {"PF 2nd":>8}')
    for name, r in (('>= $15 double', ge), ('<= $15 double', le)):
        a, b = stats(r['vals'][:half]), stats(r['vals'][half:])
        w(f'  {name:<20} {a["total"]*USDINR:>+12,.0f} {b["total"]*USDINR:>+12,.0f} '
          f'{a["pf"]:>8.2f} {b["pf"]:>8.2f}')
    w('')

    w('=' * 88)
    w('AT EQUAL RISK')
    w('=' * 88)
    w(f'  {"":<20} {"SIZE x":>8} {"TOTAL Rs":>12} {"WORST Rs":>11}')
    base = ge
    for name, r in (('>= $15 double', ge), ('<= $15 double', le)):
        sc = base['mdd'] / r['mdd'] if r['mdd'] > 0 else 0
        w(f'  {name:<20} {sc:>7.2f}x {r["total"]*sc*USDINR:>+12,.0f} {r["worst"]*sc*USDINR:>+11,.0f}')
    w('')

    w('=' * 88)
    w('ON YOUR ACCOUNT, AT THE SIZE CURRENTLY SAVED (450 lots)')
    w('=' * 88)
    f = 450 / CONTRACTS
    w(f'  equity about Rs {EQUITY_INR:,}')
    w(f'  {"":<20} {"per day Rs":>12} {"worst day Rs":>14} {"% of equity":>12}')
    for name, r in (('>= $15 double', ge), ('<= $15 double', le)):
        worst = r['worst'] * f * USDINR
        w(f'  {name:<20} {r["total"]/len(dates)*f*USDINR:>+12,.0f} {worst:>+14,.0f} '
          f'{abs(worst)/EQUITY_INR*100:>11.0f}%')
    w('')
    w('=' * 88)

    text = '\n'.join(L) + '\n'
    open(OUT, 'w').write(text)
    print(text)
    print(f'wrote -> {OUT}')


if __name__ == '__main__':
    main()
