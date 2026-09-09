#!/usr/bin/env python3
"""The three strategies, broken out Monday to Sunday.

  BASELINE  every leg, no gate
  LOCKED    each leg sold only if the model puts it 95%+ to expire worthless
  DOUBLE    the same gate, and two lots of the leg that survives when the gate
            refuses its partner

For every weekday: how many days it traded, how many lots that took, what it
made, how often it won, its worst single day, and the drawdown of that weekday
on its own -- what the equity curve would have done had you traded only Mondays,
only Tuesdays, and so on.

That last column is the one worth reading carefully. A weekday's drawdown is
measured over roughly a hundred days spread across two years, so it is a much
thinner sample than the headline figure and moves a long way on one bad day. It
answers "what did Mondays do" and not "what will Mondays do".

Measured throughout: entry marks, settlement values and intraday decay paths all
come from chain.db.

  python3 research/weekday_report.py
"""
import datetime, json, math, os, sqlite3, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
OUT = os.path.join(HERE, 'WEEKDAY-REPORT.txt')

CONTRACTS, CV, SLIP, USDINR = 10, 0.001, 0.05, 85
T12, TARGET, GATE = 12 / 24 / 365, 0.05, 0.95
DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']


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


def mdd_of(vals):
    eq = peak = worst = 0.0
    for x in vals:
        eq += x
        peak = max(peak, eq)
        worst = max(worst, peak - eq)
    return worst


def main():
    con = sqlite3.connect(CHAIN)
    legs = {}
    for date, cp, k, entry, dj, sv, spot in con.execute(
            """SELECT p.date,p.cp,p.k,p.entry,p.decay,l.settle_value,d.spot FROM paths p
               JOIN legs l ON l.date=p.date AND l.cp=p.cp AND l.k=p.k
               JOIN days d ON d.date=p.date
               WHERE p.floor=15.0 AND p.entry>0"""):
        v = solve_iv(cp, spot, k, T12, entry)
        if v is None:
            continue
        d = json.loads(dj or '{}')
        hit = d.get(str(TARGET)) is not None
        legs.setdefault(date, {})[cp] = {
            'p': p_worthless(cp, spot, k, T12, v),
            'unit': entry * (1 - SLIP) - (entry * TARGET * (1 + SLIP) if hit else (sv or 0.0)),
        }
    dates = sorted(d for d in legs if len(legs[d]) == 2)

    def day_result(date, mode):
        """(pnl, lots) for one date under one strategy."""
        ok = [cp for cp in ('C', 'P') if legs[date][cp]['p'] >= GATE]
        total, lots = 0.0, 0
        for cp in ('C', 'P'):
            if mode == 'baseline':
                n = 1
            elif cp not in ok:
                n = 0
            elif mode == 'double' and len(ok) == 1:
                n = 2
            else:
                n = 1
            if n:
                total += money(legs[date][cp]['unit'], n)
                lots += n
        return total, lots

    L = []
    w = L.append
    w('=' * 92)
    w('THE THREE STRATEGIES, MONDAY TO SUNDAY')
    w('=' * 92)
    w(f'  {len(dates):,} days, {dates[0]} to {dates[-1]}.  {CONTRACTS} contracts per lot,')
    w(f'  {SLIP*100:.0f}% slippage, 95% decay target. Everything measured from chain.db.')
    w('')
    w('  MDD here is that weekday on its own -- the drawdown of an equity curve')
    w('  made only of Mondays, only of Tuesdays, and so on. About a hundred days')
    w('  each, so it is a thin sample and one bad day moves it a long way.')
    w('')

    totals = {}
    for mode, title in (('baseline', 'BASELINE  -- every leg, no gate'),
                        ('locked', 'LOCKED    -- gate 95%, one lot per surviving leg'),
                        ('double', 'DOUBLE    -- gate 95%, two lots when only one leg survives')):
        w('=' * 92)
        w(title)
        w('=' * 92)
        w(f'  {"DAY":<10} {"DAYS":>5} {"TRADED":>7} {"LOTS":>5} {"NET Rs":>9} {"/DAY":>8} '
          f'{"WIN%":>6} {"WINS":>5} {"LOSSES":>7} {"WORST Rs":>9} {"MDD Rs":>8}')
        w('  ' + '-' * 88)
        allv = []
        rows = []
        for wd in range(7):
            ds = [d for d in dates if datetime.date.fromisoformat(d).weekday() == wd]
            vals, lots = [], 0
            for d in ds:
                pnl, n = day_result(d, mode)
                vals.append(pnl)
                lots += n
            traded = [x for x in vals if x != 0]
            wins = [x for x in traded if x > 0]
            losses = [x for x in traded if x <= 0]
            allv.extend(vals)
            rows.append((wd, sum(vals)))
            w(f'  {DAYS[wd]:<10} {len(ds):>5} {len(traded):>7} {lots:>5} '
              f'{sum(vals)*USDINR:>+9,.0f} {(st.fmean(vals) if vals else 0)*USDINR:>+8.2f} '
              f'{(len(wins)/len(traded)*100 if traded else 0):>5.1f}% {len(wins):>5} {len(losses):>7} '
              f'{(min(vals) if vals else 0)*USDINR:>+9,.0f} {mdd_of(vals)*USDINR:>8,.0f}')
        w('  ' + '-' * 88)
        traded_all = [x for x in allv if x != 0]
        wins_all = [x for x in traded_all if x > 0]
        w(f'  {"ALL":<10} {len(allv):>5} {len(traded_all):>7} {"":>5} '
          f'{sum(allv)*USDINR:>+9,.0f} {st.fmean(allv)*USDINR:>+8.2f} '
          f'{len(wins_all)/len(traded_all)*100:>5.1f}% {len(wins_all):>5} '
          f'{len(traded_all)-len(wins_all):>7} {min(allv)*USDINR:>+9,.0f} '
          f'{mdd_of(allv)*USDINR:>8,.0f}')
        w('')
        best = max(rows, key=lambda r: r[1])
        worst = min(rows, key=lambda r: r[1])
        w(f'  best day of the week   {DAYS[best[0]]:<10} Rs {best[1]*USDINR:+,.0f}')
        w(f'  worst day of the week  {DAYS[worst[0]]:<10} Rs {worst[1]*USDINR:+,.0f}')
        w('')
        totals[mode] = {wd: t for wd, t in rows}

    # ------------------------------------------------ side by side, by day
    w('=' * 92)
    w('NET BY WEEKDAY, THE THREE SIDE BY SIDE')
    w('=' * 92)
    w(f'  {"DAY":<10} {"BASELINE Rs":>13} {"LOCKED Rs":>12} {"DOUBLE Rs":>12} {"DBL vs BASE":>13}')
    w('  ' + '-' * 66)
    for wd in range(7):
        b, l, d = totals['baseline'][wd], totals['locked'][wd], totals['double'][wd]
        ch = f'{(d-b)/abs(b)*100:+.0f}%' if b else '--'
        w(f'  {DAYS[wd]:<10} {b*USDINR:>+13,.0f} {l*USDINR:>+12,.0f} {d*USDINR:>+12,.0f} {ch:>13}')
    w('  ' + '-' * 66)
    tb, tl, td = (sum(totals[m].values()) for m in ('baseline', 'locked', 'double'))
    w(f'  {"TOTAL":<10} {tb*USDINR:>+13,.0f} {tl*USDINR:>+12,.0f} {td*USDINR:>+12,.0f} '
      f'{(td-tb)/abs(tb)*100:>+12.0f}%')
    w('')
    w('  Where DOUBLE beats the baseline on a weekday it is doing it with fewer')
    w('  lots, because the gate is still refusing legs on that day too.')
    w('')

    # -------------------------------------------------------- weekend note
    w('=' * 92)
    w('WEEKDAYS AGAINST WEEKENDS')
    w('=' * 92)
    for mode in ('baseline', 'locked', 'double'):
        wkdy = sum(totals[mode][wd] for wd in range(5))
        wknd = sum(totals[mode][wd] for wd in (5, 6))
        w(f'  {mode:<10} Mon-Fri Rs {wkdy*USDINR:>+9,.0f}   Sat-Sun Rs {wknd*USDINR:>+9,.0f}   '
          f'weekend share {wknd/(wkdy+wknd)*100:>5.1f}%')
    w('')
    w('  MOVE-TIMETABLE.txt measured Saturday and Sunday moving about 40% less')
    w('  than a weekday, so a quieter weekend earning less in absolute terms is')
    w('  the premium being smaller, not the days being worse.')
    w('=' * 92)

    text = '\n'.join(L) + '\n'
    open(OUT, 'w').write(text)
    print(text)
    print(f'wrote -> {OUT}')


if __name__ == '__main__':
    main()
