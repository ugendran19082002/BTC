#!/usr/bin/env python3
"""Lowest risk or most participation: the decision, with a gate that survives.

The 99% observed-rate gate looked like the answer -- profit factor 5.90 and a
worst day of Rs -333 against the baseline's Rs -1,526. Calibrated honestly it
selected seven legs out of 734, and the reason is worth understanding rather
than working around.

WHY THE BUCKET GATE IS UNSTABLE
---------------------------------------------------------------------------
"Observed rate >= 99%" is a question about a *bucket*, and near the top the
buckets are small and their rates are steps, not slopes. A bucket holding 200
legs with two failures reads 99.0% and passes; one more failure reads 98.5% and
the entire bucket stops trading. The gate is not selecting safer legs, it is
selecting whichever buckets happened to go unblemished, and that flips between
halves of the record.

THE STABLE WAY TO ASK THE SAME THING
---------------------------------------------------------------------------
Model probability is a smooth number attached to each leg rather than a shared
verdict on a bucket. The calibration says where to put the line: legs the model
scores at 97% or better settled at zero 99.3% of the time or better, every
bucket, across the whole record. So "model >= 97%" is what "I want 99% real
safety" should have been asking for -- the same intent, expressed in a number
that cannot flip because one leg in a neighbouring bucket went wrong.

This sweeps that line and puts the decision side by side.

  python3 research/gate_decision.py
"""
import json, math, os, sqlite3, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
OUT = os.path.join(HERE, 'GATE-DECISION.txt')

CONTRACTS, CV, SLIP, USDINR = 10, 0.001, 0.05, 85
T12 = 12 / 24 / 365
TARGET = 0.05
BARS = [None, 0.94, 0.95, 0.96, 0.97, 0.975, 0.98]


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
    sq = v * math.sqrt(t)
    d2 = (math.log(s / k) + 0.5 * v * v * t) / sq - sq
    return cdf(-d2) if cp == 'C' else cdf(d2)


def main():
    con = sqlite3.connect(CHAIN)
    L = []
    w = L.append

    rows = con.execute("""SELECT p.date,p.cp,p.k,p.entry,p.decay,l.settle_value,d.spot
                          FROM paths p
                          JOIN legs l ON l.date=p.date AND l.cp=p.cp AND l.k=p.k
                          JOIN days d ON d.date=p.date
                          WHERE p.floor=15.0 AND p.entry>0""").fetchall()
    legs = {}
    for date, cp, k, entry, dj, sv, spot in rows:
        v = solve_iv(cp, spot, k, T12, entry)
        if v is None:
            continue
        d = json.loads(dj or '{}')
        hit = d.get(str(TARGET)) is not None
        legs.setdefault(date, {})[cp] = {
            'p': p_worthless(cp, spot, k, T12, v),
            'pnl': money(entry * (1 - SLIP) - (entry * TARGET * (1 + SLIP) if hit else (sv or 0.0))),
            'zero': (sv == 0),
        }
    dates = sorted(d for d in legs if len(legs[d]) == 2)
    half = len(dates) // 2

    def run(bar, sides, days):
        vals, sold, zeros = [], 0, 0
        for d in days:
            t = 0.0
            for cp in sides:
                g = legs[d][cp]
                if bar is None or g['p'] >= bar:
                    t += g['pnl']
                    sold += 1
                    zeros += 1 if g['zero'] else 0
            vals.append(t)
        traded = [x for x in vals if x != 0]
        wins = [x for x in traded if x > 0]
        gl = -sum(x for x in traded if x <= 0)
        eq = peak = mdd = 0.0
        for x in vals:
            eq += x
            peak = max(peak, eq)
            mdd = max(mdd, peak - eq)
        return {
            'total': sum(vals), 'sold': sold, 'days': len(traded),
            'win': (len(wins) / len(traded) * 100) if traded else 0,
            'pf': (sum(wins) / gl) if gl else float('inf'),
            'worst': min(vals) if vals else 0, 'mdd': mdd,
            'acc': (zeros / sold * 100) if sold else 0,
        }

    w('=' * 90)
    w('THE DECISION:  LOWEST RISK  vs  MAXIMUM PARTICIPATION')
    w('=' * 90)
    w('Baseline 05:30 IST, richest strike at or below $15, buy back at 95% decay.')
    w(f'{CONTRACTS} contracts per leg, {SLIP*100:.0f}% slippage, {len(dates)} days, all measured.')
    w('')
    w('WHY THIS USES A MODEL LINE AND NOT AN OBSERVED-RATE LINE')
    w('  "observed rate >= 99%" judges a bucket, and near the top a bucket of 200')
    w('  legs flips from 99.0% to 98.5% on one bad leg, taking every leg in it out')
    w('  of the strategy. That is why it selected 275 legs calibrated one way and')
    w('  7 the other. Model probability is per leg and moves smoothly, and the')
    w('  calibration says legs scored 97%+ settled at zero 99.3%+ of the time --')
    w('  so a 97% model line is the stable way to ask for 99% real safety.')
    w('')

    for side_label, sides in (('BOTH LEGS', ('C', 'P')), ('CALL ONLY', ('C',)), ('PUT ONLY', ('P',))):
        w('=' * 90)
        w(side_label)
        w('=' * 90)
        w(f'  {"GATE":<16} {"SOLD":>5} {"DAYS":>5} {"ACTUAL 0%":>10} {"TOTAL Rs":>10} '
          f'{"/DAY":>7} {"WIN%":>6} {"PF":>6} {"WORST":>8} {"MDD":>7}')
        w('  ' + '-' * 84)
        for bar in BARS:
            r = run(bar, sides, dates)
            name = 'no gate' if bar is None else f'model >= {bar*100:g}%'
            w(f'  {name:<16} {r["sold"]:>5} {r["days"]:>5} {r["acc"]:>9.2f}% '
              f'{r["total"]*USDINR:>+10,.0f} {r["total"]/len(dates)*USDINR:>+7.2f} '
              f'{r["win"]:>5.1f}% {r["pf"]:>6.2f} {r["worst"]*USDINR:>+8,.0f} {r["mdd"]*USDINR:>7,.0f}')
        w('')

    w('=' * 90)
    w('OUT OF SAMPLE -- the same lines, each half scored on its own')
    w('=' * 90)
    w('  A model line needs no calibration to apply, so nothing here has seen the')
    w('  days it judges. This is the test the bucket gate failed.')
    w('')
    w(f'  {"GATE":<16} {"LEGS":<6} {"1st half":>10} {"2nd half":>10} {"1st PF":>7} {"2nd PF":>7} {"holds?":>7}')
    w('  ' + '-' * 72)
    for bar in BARS:
        for side_label, sides in (('both', ('C', 'P')), ('CE', ('C',)), ('PE', ('P',))):
            a = run(bar, sides, dates[:half])
            b = run(bar, sides, dates[half:])
            name = 'no gate' if bar is None else f'model >= {bar*100:g}%'
            ok = 'yes' if a['total'] > 0 and b['total'] > 0 else 'NO'
            w(f'  {name:<16} {side_label:<6} {a["total"]*USDINR:>+10,.0f} {b["total"]*USDINR:>+10,.0f} '
              f'{a["pf"]:>7.2f} {b["pf"]:>7.2f} {ok:>7}')
        w('')

    w('=' * 90)
    w('AT EQUAL RISK -- each line sized so its drawdown matches the baseline')
    w('=' * 90)
    base = run(None, ('C', 'P'), dates)
    w(f'  baseline drawdown Rs {base["mdd"]*USDINR:,.0f}, total Rs {base["total"]*USDINR:+,.0f}')
    w('')
    w(f'  {"GATE":<16} {"LEGS":<6} {"SIZE x":>7} {"TOTAL Rs":>11} {"vs BASE":>9} {"WORST Rs":>10}')
    w('  ' + '-' * 66)
    for bar in BARS:
        for side_label, sides in (('both', ('C', 'P')), ('CE', ('C',)), ('PE', ('P',))):
            r = run(bar, sides, dates)
            if r['mdd'] <= 0:
                continue
            sc = base['mdd'] / r['mdd']
            name = 'no gate' if bar is None else f'model >= {bar*100:g}%'
            w(f'  {name:<16} {side_label:<6} {sc:>6.2f}x {r["total"]*sc*USDINR:>+11,.0f} '
              f'{(r["total"]*sc/base["total"]-1)*100:>+8.0f}% {r["worst"]*sc*USDINR:>+10,.0f}')
        w('')
    w('  Sizing up a gated strategy assumes the record repeats. It is the same')
    w('  assumption every table here makes; it is a comparison, not a promise.')
    w('=' * 90)

    text = '\n'.join(L) + '\n'
    open(OUT, 'w').write(text)
    print(text)
    print(f'wrote -> {OUT}')


if __name__ == '__main__':
    main()
