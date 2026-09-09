#!/usr/bin/env python3
"""On a one-sided day, does doubling the qualifying leg pay?

The 95% gate is applied per leg, so 36% of days sell one leg rather than two.
The capital freed by the refused leg is sitting idle, and the obvious question
is whether it should go on the leg that passed.

Three ways to answer it:

  LOCKED    what was decided. One lot per qualifying leg, whatever that means
            for the day: two legs, one, or none.

  DOUBLE    on a one-sided day, sell two lots of the leg that qualified. Days
            where both legs qualify are unchanged.

  ALWAYS 2  two lots on every qualifying leg, one-sided or not. The control --
            without it, DOUBLE's extra return could just be extra size rather
            than extra size *placed well*.

The control matters. Doubling on one-sided days puts more money to work, and
more money at work in a profitable strategy makes more money whether or not the
placement was clever. ALWAYS 2 separates the two: if DOUBLE beats LOCKED by the
same ratio ALWAYS 2 does, the one-sided idea added nothing.

There is a second thing worth naming. A one-sided short is not this strategy.
Both legs together are a bet that BTC stays put; one leg alone is a bet that it
does not go one particular way. `recommend.ts` says it plainly -- "One leg alone
is a directional bet, not this strategy" -- and doubling that leg doubles the
directional bet, on the day the gate has already said the board looks unusual.
The tables below say what that cost or paid.

All measured from chain.db.

  python3 research/one_sided_double.py
"""
import json, math, os, sqlite3, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
OUT = os.path.join(HERE, 'ONE-SIDED-DOUBLE.txt')

CONTRACTS, CV, SLIP, USDINR = 10, 0.001, 0.05, 85
T12, TARGET, GATE = 12 / 24 / 365, 0.05, 0.95
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
        'losers': len([x for x in traded if x <= 0]),
    }


def main():
    con = sqlite3.connect(CHAIN)
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
        unit = entry * (1 - SLIP) - (entry * TARGET * (1 + SLIP) if hit else (sv or 0.0))
        legs.setdefault(date, {})[cp] = {'p': p_worthless(cp, spot, k, T12, v), 'unit': unit}
    dates = sorted(d for d in legs if len(legs[d]) == 2)

    def run(mode):
        vals, lots_sold = [], 0
        for d in dates:
            ok = [cp for cp in ('C', 'P') if legs[d][cp]['p'] >= GATE]
            t = 0.0
            for cp in ok:
                if mode == 'locked':
                    lots = 1
                elif mode == 'double':
                    lots = 2 if len(ok) == 1 else 1
                else:                       # always2
                    lots = 2
                t += money(legs[d][cp]['unit'], lots)
                lots_sold += lots
            vals.append(t)
        s = stats(vals)
        s['lots'] = lots_sold
        s['vals'] = vals
        return s

    res = {m: run(m) for m in ('locked', 'double', 'always2')}
    L = []
    w = L.append

    both = sum(1 for d in dates if all(legs[d][cp]['p'] >= GATE for cp in ('C', 'P')))
    one = sum(1 for d in dates
              if sum(1 for cp in ('C', 'P') if legs[d][cp]['p'] >= GATE) == 1)
    none = len(dates) - both - one

    w('=' * 84)
    w('ONE-SIDED DAYS:  DOUBLE THE LEG THAT QUALIFIED?')
    w('=' * 84)
    w(f'  {len(dates):,} days, {dates[0]} to {dates[-1]}.  Base size {CONTRACTS} contracts.')
    w(f'  both legs qualify {both} days, one leg {one} days, neither {none} days.')
    w(f'  So the doubling only touches {one} days ({one/len(dates)*100:.0f}% of the record).')
    w('')
    w(f'  {"":<22} {"LOCKED":>13} {"DOUBLE":>13} {"ALWAYS 2":>13}')
    w('  ' + '-' * 64)
    for label, key, fmt, mul in [
        ('lots sold', 'lots', '{:,.0f}', 1),
        ('TOTAL Rs', 'total', '{:+,.0f}', USDINR),
        ('win rate', 'win', '{:.1f}%', 1),
        ('profit factor', 'pf', '{:.2f}', 1),
        ('losing days', 'losers', '{:,.0f}', 1),
        ('worst day Rs', 'worst', '{:+,.0f}', USDINR),
        ('max drawdown Rs', 'mdd', '{:,.0f}', USDINR),
    ]:
        cells = [fmt.format(res[m][key] * mul) for m in ('locked', 'double', 'always2')]
        w(f'  {label:<22} {cells[0]:>13} {cells[1]:>13} {cells[2]:>13}')
    w('')

    # the control question, stated as a ratio
    lk, db, a2 = res['locked'], res['double'], res['always2']
    w('=' * 84)
    w('IS IT THE PLACEMENT, OR JUST THE SIZE?')
    w('=' * 84)
    w(f'  {"":<26} {"vs LOCKED":>12} {"lots vs LOCKED":>16}')
    w(f'  {"DOUBLE":<26} {db["total"]/lk["total"]:>11.3f}x {db["lots"]/lk["lots"]:>15.3f}x')
    w(f'  {"ALWAYS 2":<26} {a2["total"]/lk["total"]:>11.3f}x {a2["lots"]/lk["lots"]:>15.3f}x')
    w('')
    edge = (db['total'] / lk['total']) / (db['lots'] / lk['lots'])
    w(f'  Return per lot, DOUBLE against LOCKED: {edge:.3f}x')
    w('  Above 1.00 means the extra lots did better than the average lot -- the')
    w('  one-sided leg was a better bet. Below 1.00 means they did worse and the')
    w('  gain is only the extra size, which could have been had by simply')
    w('  trading larger every day.')
    w('')

    # what one-sided days are actually like
    w('=' * 84)
    w('WHAT A ONE-SIDED DAY IS WORTH, PER LOT')
    w('=' * 84)
    onesided, twosided = [], []
    for d in dates:
        ok = [cp for cp in ('C', 'P') if legs[d][cp]['p'] >= GATE]
        for cp in ok:
            (onesided if len(ok) == 1 else twosided).append(money(legs[d][cp]['unit']))
    for name, xs in (('legs on one-sided days', onesided), ('legs on two-sided days', twosided)):
        wins = [x for x in xs if x > 0]
        gl = -sum(x for x in xs if x <= 0)
        w(f'  {name:<26} {len(xs):>5} legs   avg Rs {st.fmean(xs)*USDINR:>+7.2f}   '
          f'win {len(wins)/len(xs)*100:>5.1f}%   worst Rs {min(xs)*USDINR:>+8,.0f}   '
          f'PF {(sum(wins)/gl if gl else float("inf")):>5.2f}')
    w('')
    w('  This is the number the whole idea rests on. If a leg sold on a one-sided')
    w('  day is worth less per lot than one sold alongside a partner, then putting')
    w('  more size on it is putting more size on the worse trade.')
    w('')

    w('=' * 84)
    w('OUT OF SAMPLE')
    w('=' * 84)
    half = len(dates) // 2
    w(f'  {"":<12} {"1st half Rs":>12} {"2nd half Rs":>12} {"PF 1st":>8} {"PF 2nd":>8}')
    for m in ('locked', 'double', 'always2'):
        a, b = stats(res[m]['vals'][:half]), stats(res[m]['vals'][half:])
        w(f'  {m:<12} {a["total"]*USDINR:>+12,.0f} {b["total"]*USDINR:>+12,.0f} '
          f'{a["pf"]:>8.2f} {b["pf"]:>8.2f}')
    w('')

    w('=' * 84)
    w('AT EQUAL RISK')
    w('=' * 84)
    w('  Sized so each carries the same drawdown as LOCKED.')
    w(f'  {"":<12} {"SIZE x":>8} {"TOTAL Rs":>12} {"vs LOCKED":>11}')
    for m in ('locked', 'double', 'always2'):
        r = res[m]
        sc = lk['mdd'] / r['mdd'] if r['mdd'] > 0 else 0
        w(f'  {m:<12} {sc:>7.2f}x {r["total"]*sc*USDINR:>+12,.0f} '
          f'{(r["total"]*sc/lk["total"]-1)*100:>+10.0f}%')
    w('')
    w('=' * 84)
    w('ON YOUR ACCOUNT')
    w('=' * 84)
    w(f'  Equity Rs {EQUITY_INR:,}. Worst day at each base size:')
    w(f'  {"BASE":>6} {"LOCKED /day":>12} {"DOUBLE /day":>12} {"LOCKED worst":>13} {"DOUBLE worst":>13}')
    for n in (50, 100, 137, 200):
        f = n / CONTRACTS
        w(f'  {n:>6} {lk["total"]/len(dates)*f*USDINR:>+12,.0f} '
          f'{db["total"]/len(dates)*f*USDINR:>+12,.0f} '
          f'{lk["worst"]*f*USDINR:>+13,.0f} {db["worst"]*f*USDINR:>+13,.0f}')
    w('')
    w('  Note the margin: DOUBLE needs twice the margin on a one-sided day, which')
    w('  is the day the desk had decided the board was not offering a fair price')
    w('  on one side. Whether that is the day to be twice as large is a judgement')
    w('  the numbers above inform but do not make.')
    w('=' * 84)

    text = '\n'.join(L) + '\n'
    open(OUT, 'w').write(text)
    print(text)
    print(f'wrote -> {OUT}')


if __name__ == '__main__':
    main()
