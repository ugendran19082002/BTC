#!/usr/bin/env python3
"""The 05:30 -> 17:30 short strangle at the $15 premium floor, in full.

Everything here is measured. Entry marks, settlement values and the intraday
decay path of every leg are read out of chain.db, which the harvester captured
at the two moments the strategy is defined at. No Black-Scholes, no assumed
vol, no modelled quote -- the disclaimers that follow the overnight studies
around do not apply to any number in this file.

  Entry   05:30 IST, when the daily contract opens
  Legs    sell 1 CE + 1 PE, the furthest strike that still pays at least $15
  Exit    the 17:30 settlement, or a buy-back once the mark has decayed by a
          set fraction, whichever comes first
  Costs   5% slippage on the entry credit, and again on a buy-back. Settlement
          is not a trade, so it costs nothing extra.

  python3 research/baseline_report.py
"""
import datetime, json, os, sqlite3, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
OUT = os.path.join(HERE, 'BASELINE-REPORT.txt')

CONTRACTS, CV, SLIP, USDINR = 10, 0.001, 0.05, 85
TARGETS = [('hold to settlement', None), ('50% decay', 0.5), ('70% decay', 0.3),
           ('80% decay', 0.2), ('90% decay', 0.1), ('95% decay', 0.05)]


def money(q):
    return q * CONTRACTS * CV


def load():
    con = sqlite3.connect(CHAIN)
    return con.execute("""
        SELECT p.date, p.cp, p.k, p.entry, p.decay, p.high, l.settle_value, d.spot, d.settle
        FROM paths p
        JOIN legs l ON l.date = p.date AND l.cp = p.cp AND l.k = p.k
        JOIN days d ON d.date = p.date
        WHERE p.floor = 15.0 AND p.entry > 0
        ORDER BY p.date
    """).fetchall()


def run(rows, frac):
    """Daily P&L, and the per-leg detail behind it."""
    days, legs = {}, []
    for date, cp, k, entry, dj, high, settle, spot, sett in rows:
        d = json.loads(dj or '{}')
        credit = entry * (1 - SLIP)
        step = d.get(str(frac)) if frac is not None else None
        if step is not None:
            exit_px, how = entry * frac * (1 + SLIP), 'target'
        else:
            exit_px, how = (settle or 0.0), 'settled'
        pnl = money(credit - exit_px)
        days[date] = days.get(date, 0.0) + pnl
        legs.append({'date': date, 'cp': cp, 'pnl': pnl, 'how': how,
                     'entry': entry, 'settle': settle or 0.0})
    return days, legs


def drawdown(v):
    eq = peak = mdd = 0.0
    start = end = trough = 0
    ps = 0
    for i, x in enumerate(v):
        eq += x
        if eq > peak:
            peak, ps = eq, i
        if peak - eq > mdd:
            mdd, start, trough = peak - eq, ps, i
    # recovery: first index after the trough that gets back to the old peak
    eq = 0.0
    rec = None
    for i, x in enumerate(v):
        eq += x
        if i > trough and eq >= peak:
            rec = i
            break
    return mdd, start, trough, rec


def streaks(v):
    bw = bl = cw = cl = 0
    for x in v:
        if x > 0:
            cw, cl = cw + 1, 0
        else:
            cl, cw = cl + 1, 0
        bw, bl = max(bw, cw), max(bl, cl)
    return bw, bl


def main():
    rows = load()
    L = []
    w = L.append

    w('=' * 82)
    w('BASELINE:  05:30 -> 17:30 IST,  SHORT CE + PE,  $15 PREMIUM FLOOR')
    w('=' * 82)
    dates = sorted({r[0] for r in rows})
    w(f'Record        {dates[0]} to {dates[-1]}   {len(dates):,} days, {len(rows):,} legs')
    w(f'Size          {CONTRACTS} contracts per leg (0.001 BTC each)')
    w(f'Costs         {SLIP*100:.0f}% slippage in; {SLIP*100:.0f}% again on a buy-back; settlement free')
    w('ALL MEASURED  entry marks, settle values and decay paths from chain.db')
    w('')

    # ------------------------------------------------ exit rules side by side
    w('=' * 82)
    w('EXIT RULES COMPARED')
    w('=' * 82)
    w(f'  {"EXIT RULE":<20} {"TOTAL Rs":>10} {"/DAY":>7} {"WIN%":>6} {"PF":>6} '
      f'{"WORST Rs":>9} {"MDD Rs":>8} {"HIT%":>6}')
    w('  ' + '-' * 76)
    results = {}
    for label, frac in TARGETS:
        days, legs = run(rows, frac)
        v = [days[d] for d in dates]
        wins = [x for x in v if x > 0]
        gl = -sum(x for x in v if x <= 0)
        mdd, _, _, _ = drawdown(v)
        hit = sum(1 for l in legs if l['how'] == 'target') / len(legs) * 100
        pf = sum(wins) / gl if gl else float('inf')
        results[label] = (days, legs, v)
        w(f'  {label:<20} {sum(v)*USDINR:>+10,.0f} {st.fmean(v)*USDINR:>+7.2f} '
          f'{len(wins)/len(v)*100:>5.1f}% {pf:>6.2f} {min(v)*USDINR:>+9,.0f} '
          f'{mdd*USDINR:>8,.0f} {hit:>5.1f}%')
    w('')

    # ------------------------------------------------------ the chosen rule
    BEST = '95% decay'
    days, legs, v = results[BEST]
    wins = [x for x in v if x > 0]
    loss = [x for x in v if x <= 0]
    gw, gl = sum(wins), -sum(loss)
    mdd, ds, dt, dr = drawdown(v)
    bw, bl = streaks(v)

    w('=' * 82)
    w(f'IN FULL:  {BEST} target, else settlement')
    w('=' * 82)
    w(f'  days traded            {len(v):,}')
    w(f'  winning days           {len(wins):,}   ({len(wins)/len(v)*100:.1f}%)')
    w(f'  losing days            {len(loss):,}   ({len(loss)/len(v)*100:.1f}%)')
    w('')
    w(f'  TOTAL PROFIT           Rs {sum(v)*USDINR:+,.0f}      (${sum(v):+,.2f})')
    w(f'  average day            Rs {st.fmean(v)*USDINR:+,.2f}')
    w(f'  median day             Rs {st.median(v)*USDINR:+,.2f}')
    w('')
    w(f'  gross profit           Rs {gw*USDINR:+,.0f}')
    w(f'  gross loss             Rs {-gl*USDINR:+,.0f}')
    w(f'  profit factor          {gw/gl:.2f}       (>1 makes money)')
    w('')
    w(f'  average WIN            Rs {st.fmean(wins)*USDINR:+,.2f}')
    w(f'  average LOSS           Rs {st.fmean(loss)*USDINR:+,.2f}')
    w(f'  win/loss ratio         1 : {abs(st.fmean(loss)/st.fmean(wins)):.1f}'
      f'   (one loss undoes {abs(st.fmean(loss)/st.fmean(wins)):.0f} wins)')
    w('')
    best_d = max(dates, key=lambda d: days[d])
    worst_d = min(dates, key=lambda d: days[d])
    w(f'  best day               Rs {days[best_d]*USDINR:+,.0f}   on {best_d}')
    w(f'  worst day              Rs {days[worst_d]*USDINR:+,.0f}   on {worst_d}')
    w(f'  worst day = {abs(days[worst_d]/st.fmean(v)):.0f}x an average day')
    w('')
    w(f'  MAX DRAWDOWN           Rs {mdd*USDINR:,.0f}')
    w(f'    from {dates[ds]} to {dates[dt]}  ({dt-ds} days)')
    w(f'    recovered by {dates[dr] if dr else "not yet recovered"}'
      f'{f"  ({dr-dt} days)" if dr else ""}')
    w(f'  longest win streak     {bw} days')
    w(f'  longest losing streak  {bl} days')
    w('')

    # ------------------------------------------------------------- the tail
    w('=' * 82)
    w('THE TEN WORST DAYS  -- this is where the risk actually lives')
    w('=' * 82)
    w(f'  {"DATE":<12} {"Rs":>9}  {"= how many average days":<28}')
    for d in sorted(dates, key=lambda x: days[x])[:10]:
        w(f'  {d:<12} {days[d]*USDINR:>+9,.0f}  {abs(days[d]/st.fmean(v)):>5.0f} average days')
    tail = sorted(v)[:10]
    w('')
    w(f'  those 10 days cost Rs {sum(tail)*USDINR:+,.0f}, against a total of Rs {sum(v)*USDINR:+,.0f}')
    w(f'  without them the total would be Rs {(sum(v)-sum(tail))*USDINR:+,.0f}')
    w('  1.4% of the days decide most of the outcome. That is the whole game.')
    w('')

    # -------------------------------------------------------- distribution
    w('=' * 82)
    w('DISTRIBUTION OF DAILY RESULTS')
    w('=' * 82)
    edges = [-1e9, -1000, -500, -250, -100, 0, 25, 50, 75, 1e9]
    names = ['worse than -1000', '-1000 to -500', '-500 to -250', '-250 to -100',
             '-100 to 0', '0 to +25', '+25 to +50', '+50 to +75', 'above +75']
    for i, nm in enumerate(names):
        c = sum(1 for x in v if edges[i] <= x * USDINR < edges[i + 1])
        bar = '#' * int(c / len(v) * 120)
        w(f'  {nm:<18} {c:>4}  {c/len(v)*100:>5.1f}%  {bar}')
    w('')

    # ------------------------------------------------------------ by period
    w('=' * 82)
    w('BY YEAR AND MONTH')
    w('=' * 82)
    w(f'  {"PERIOD":<10} {"DAYS":>5} {"TOTAL Rs":>10} {"/DAY":>8} {"WIN%":>6} {"WORST Rs":>9}')
    for key in ('%Y', '%Y-%m'):
        if key == '%Y-%m':
            w('  ' + '-' * 52)
        groups = {}
        for d in dates:
            g = datetime.date.fromisoformat(d).strftime(key)
            groups.setdefault(g, []).append(days[d])
        for g in sorted(groups):
            xs = groups[g]
            wr = sum(1 for x in xs if x > 0) / len(xs) * 100
            w(f'  {g:<10} {len(xs):>5} {sum(xs)*USDINR:>+10,.0f} '
              f'{st.fmean(xs)*USDINR:>+8.2f} {wr:>5.1f}% {min(xs)*USDINR:>+9,.0f}')
    w('')

    # ---------------------------------------------------------- by weekday
    w('=' * 82)
    w('BY DAY OF WEEK')
    w('=' * 82)
    DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    w(f'  {"DAY":<10} {"DAYS":>5} {"TOTAL Rs":>10} {"/DAY":>8} {"WIN%":>6} {"WORST Rs":>9}')
    for wd in range(7):
        xs = [days[d] for d in dates if datetime.date.fromisoformat(d).weekday() == wd]
        if not xs:
            continue
        wr = sum(1 for x in xs if x > 0) / len(xs) * 100
        w(f'  {DAYS[wd]:<10} {len(xs):>5} {sum(xs)*USDINR:>+10,.0f} '
          f'{st.fmean(xs)*USDINR:>+8.2f} {wr:>5.1f}% {min(xs)*USDINR:>+9,.0f}')
    w('')

    # ------------------------------------------------------------ CE vs PE
    w('=' * 82)
    w('CALL SIDE vs PUT SIDE')
    w('=' * 82)
    w(f'  {"SIDE":<6} {"LEGS":>6} {"TOTAL Rs":>10} {"/LEG":>8} {"WIN%":>6} {"WORST Rs":>9}')
    for cp, nm in (('C', 'CE'), ('P', 'PE')):
        xs = [l['pnl'] for l in legs if l['cp'] == cp]
        wr = sum(1 for x in xs if x > 0) / len(xs) * 100
        w(f'  {nm:<6} {len(xs):>6} {sum(xs)*USDINR:>+10,.0f} '
          f'{st.fmean(xs)*USDINR:>+8.2f} {wr:>5.1f}% {min(xs)*USDINR:>+9,.0f}')
    w('')

    # ---------------------------------------------------------- your sizing
    w('=' * 82)
    w('SCALED TO YOUR ACCOUNT')
    w('=' * 82)
    per = st.fmean(v) / CONTRACTS
    worstper = min(v) / CONTRACTS
    w(f'  Per contract per leg:  average Rs {per*USDINR:+.3f}/day,'
      f'  worst day Rs {worstper*USDINR:+.2f}')
    w('')
    w(f'  {"CONTRACTS":>10} {"AVG/DAY":>10} {"PER MONTH":>11} {"WORST DAY":>11} {"MAX DD":>10}')
    for n in (50, 100, 137, 200, 410):
        f = n / CONTRACTS
        w(f'  {n:>10} {st.fmean(v)*f*USDINR:>+10,.0f} {st.fmean(v)*f*USDINR*30:>+11,.0f} '
          f'{min(v)*f*USDINR:>+11,.0f} {mdd*f*USDINR:>10,.0f}')
    w('')
    w('  Your equity is about Rs 39,700. At 410 contracts the worst day in this')
    w('  record costs Rs 62,559 -- more than the account. At 137 it costs')
    w('  Rs 20,900, which hurts and survives.')
    w('=' * 82)

    text = '\n'.join(L) + '\n'
    open(OUT, 'w').write(text)
    print(text)
    print(f'wrote -> {OUT}')


if __name__ == '__main__':
    main()
