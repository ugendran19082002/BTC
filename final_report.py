#!/usr/bin/env python3
"""The full report: premium floors, the four variants, weekday, hedging.

Reads chain.db. Writes DESK-REPORT.txt.

  python3 final_report.py
"""
import datetime, statistics as st, sys
import store
from study_premium import load, otm, pick_floor, pnl, stats, LOT, LOTS, SLIP, USDINR, FLOORS

VARIANTS = [
    ("A   CE 0-15  + PE 0-15",  (0, 15), (0, 15)),
    ("B   CE 0-15  + PE 15-30", (0, 15), (15, 30)),
    ("C   CE 0-15  + PE 15-40", (0, 15), (15, 40)),
    ("D'  CE 0-20  + PE 0-20",  (0, 20), (0, 20)),
    ("    CE only 0-15",        (0, 15), None),
    ("    PE only 0-15",        None,    (0, 15)),
]


def pick_band(day, cp, band):
    """AlgoTest's Premium Range: the richest strike inside the band."""
    lo, hi = band
    c = [l for l in otm(day, cp) if lo <= l['mark'] <= hi]
    return max(c, key=lambda l: l['mark']) if c else None


def run_variant(days, ce, pe, skip_weekdays=()):
    rows = []
    for d in days:
        if datetime.date.fromisoformat(d['date']).weekday() in skip_weekdays:
            continue
        legs = []
        if ce:
            l = pick_band(d, 'C', ce)
            if l:
                legs.append(l)
        if pe:
            l = pick_band(d, 'P', pe)
            if l:
                legs.append(l)
        if not legs:
            continue
        rows.append({'date': d['date'], 'pnl': sum(pnl(l) for l in legs)})
    return rows


def row(tag, s, width=26):
    if s is None or s['n'] == 0:
        return f'{tag:<{width}} {"no tradeable day":>40}'
    pf = '   inf' if s['pf'] == float('inf') else f"{s['pf']:6.2f}"
    rmdd = '  inf' if s['mdd'] == 0 else f"{s['total']/s['mdd']:5.2f}"
    return (f"{tag:<{width}} {s['n']:>4}d  win {s['win']:5.1f}%  "
            f"${s['total']:8.2f}  Rs{s['total']*USDINR:8.0f}  PF {pf}  "
            f"worst ${s['worst']:7.2f}  MDD ${s['mdd']:6.2f}  R/MDD {rmdd}")


def main():
    out = open('DESK-REPORT.txt', 'w')

    def p(*a):
        line = ' '.join(str(x) for x in a)
        print(line)
        out.write(line + '\n')

    days = load()
    years = sorted({d['date'][:4] for d in days})

    p('=' * 122)
    p('  BTC DAILY SHORT-STRANGLE -- DESK REPORT')
    p(f'  generated {datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}')
    p('=' * 122)
    p(f'  data      : {len(days)} expiry days, {days[0]["date"]} .. {days[-1]["date"]}')
    for y in years:
        n = sum(1 for d in days if d['date'].startswith(y))
        p(f'              {y}: {n} days')
    p(f'  entry     : 05:30 IST mark price, {SLIP:.0%} slippage, {LOTS} lots ({LOTS*LOT} BTC)')
    p('  exit      : settlement intrinsic at 12:00 UTC -- exact, no exit quote needed')
    p(f'  currency  : 1 USD = Rs {USDINR:.0f}')
    p('')
    p('  Read this as a description of what these rules would have done on this')
    p('  data. It is not a forecast, and it is not AlgoTest. The AlgoTest')
    p('  reconciliation in TODO.md is still open; until it closes, treat every')
    p('  number here as a hypothesis about your live results, not a measurement.')
    p('')

    p('-' * 122)
    p('  1. THE FOUR VARIANTS -- full period')
    p('-' * 122)
    for name, ce, pe in VARIANTS:
        p(row(name, stats(run_variant(days, ce, pe))))

    p('')
    p('-' * 122)
    p('  2. THE SAME VARIANTS, YEAR BY YEAR')
    p('-' * 122)
    p('  A rule that only works in one year has not been shown to work.')
    p('')
    for name, ce, pe in VARIANTS:
        p(f'  {name}')
        for y in years:
            sub = [d for d in days if d['date'].startswith(y)]
            p('    ' + row(y, stats(run_variant(sub, ce, pe)), width=8))
        p('')

    p('-' * 122)
    p('  3. WEEKDAY vs WEEKEND -- the largest single effect in this data')
    p('-' * 122)
    p('  Monday to Friday and the weekend are close to two different strategies.')
    p('')

    def sub(wds, y=None):
        return [d for d in days
                if datetime.date.fromisoformat(d['date']).weekday() in wds
                and (y is None or d['date'].startswith(y))]

    for name, ce, pe in VARIANTS[:4]:
        p(f'  {name}')
        for label, wds in (('Mon-Fri', (0, 1, 2, 3, 4)), ('Sat+Sun', (5, 6)),
                           ('  Sat', (5,)), ('  Sun', (6,)), ('ALL', tuple(range(7)))):
            p('    ' + row(label, stats(run_variant(sub(wds), ce, pe)), width=10))
        p('')

    p('  Variant A, each year on its own -- the split is not one period speaking:')
    p('')
    for y in years:
        for label, wds in (('Mon-Fri', (0, 1, 2, 3, 4)), ('Sat+Sun', (5, 6))):
            p('    ' + row(f'{y} {label}', stats(run_variant(sub(wds, y), (0, 15), (0, 15))),
                           width=16))
        p('')

    p('  Where the losses actually are, variant A, full period:')
    p('')
    for label, wds in (('Mon-Fri', (0, 1, 2, 3, 4)), ('Sat+Sun', (5, 6))):
        rows_ = run_variant(sub(wds), (0, 15), (0, 15))
        bad_ = sorted([r for r in rows_ if r['pnl'] < 0], key=lambda r: r['pnl'])
        p(f'    {label:8} {len(bad_):>3} losing days out of {len(rows_)}')
        for r in bad_:
            wd = datetime.date.fromisoformat(r['date']).strftime('%a')
            p(f'        {r["date"]} {wd}  ${r["pnl"]:7.2f}  Rs{r["pnl"]*USDINR:7.0f}')
        p('')

    p('  A caution: ten losing days in total is a small number of events to lean on.')
    p('  The asymmetry is stark -- the weekend is 31% of the days and carries 7 of the')
    p('  10 losses and all 6 of the largest -- and it repeats in each year separately,')
    p('  which is what makes it worth acting on. It is still ten events.')
    p('')
    p('  Note this contradicts the AlgoTest Saturday-only runs you pulled earlier,')
    p('  which were negative in all four cases. Here Saturday is marginally positive')
    p('  and merely low-quality. That gap belongs to the same unresolved')
    p('  reconciliation as everything else, and is a reason to prefer the risk')
    p('  argument below over the profit argument.')
    p('')

    p('-' * 122)
    p('  4. HOW MUCH PREMIUM SHOULD YOU INSIST ON?')
    p('-' * 122)
    p('  For each floor, both legs are sold at the FURTHEST out-of-the-money strike')
    p('  that still pays at least that much -- the most distance the market will give')
    p('  you at that price.')
    p('')
    for f in FLOORS:
        rows, dist = [], []
        for d in days:
            legs = [pick_floor(d, cp, f) for cp in 'CP']
            legs = [l for l in legs if l]
            if not legs:
                continue
            rows.append({'date': d['date'], 'pnl': sum(pnl(l) for l in legs)})
            dist += [100 * abs(l['k'] - d['spot']) / d['spot'] for l in legs]
        s4 = stats(rows)
        md = f'{st.median(dist):.2f}%' if dist else '-'
        p(row(f'floor ${f}', s4) + f'  strike {md} out')
    p('')

    p('-' * 122)
    p('  5. EVERY LOSING DAY, VARIANT A')
    p('-' * 122)
    rows = []
    for d in days:
        legs = [(cp, pick_band(d, cp, (0, 15))) for cp in 'CP']
        legs = [(cp, l) for cp, l in legs if l]
        if not legs:
            continue
        rows.append({'date': d['date'], 'spot': d['spot'], 'settle': d['settle'],
                     'legs': legs, 'pnl': sum(pnl(l) for _, l in legs)})
    bad = sorted([r for r in rows if r['pnl'] < 0], key=lambda r: r['pnl'])
    p(f'  {len(bad)} losing days out of {len(rows)} traded ({100*len(bad)/max(len(rows),1):.1f}%)')
    p('')
    for r in bad:
        wd = datetime.date.fromisoformat(r['date']).strftime('%a')
        mv = 100 * (r['settle'] - r['spot']) / r['spot']
        legs = '  '.join(f"{cp}E {l['k']} @{l['mark']:.1f}->{l['settle_value']:.0f}"
                         for cp, l in r['legs'])
        p(f"  {r['date']} {wd}  {r['spot']:>9.0f} -> {r['settle']:>9.0f} ({mv:+5.2f}%)  "
          f"${r['pnl']:7.2f}  Rs{r['pnl']*USDINR:7.0f}   {legs}")

    p('')
    p('-' * 122)
    p('  6. HOW BIG A MOVE BREAKS EACH VARIANT')
    p('-' * 122)
    for name, ce, pe in VARIANTS[:4]:
        rs = []
        for d in days:
            legs = [pick_band(d, cp, b) for cp, b in (('C', ce), ('P', pe)) if b]
            legs = [l for l in legs if l]
            if not legs:
                continue
            rs.append({'pnl': sum(pnl(l) for l in legs),
                       'mv': abs(100 * (d['settle'] - d['spot']) / d['spot'])})
        w = [r['mv'] for r in rs if r['pnl'] >= 0]
        l = [r['mv'] for r in rs if r['pnl'] < 0]
        p(f'  {name:<26} win-day move {st.median(w):.2f}%   '
          f'lose-day move {st.median(l):.2f}%' if l else
          f'  {name:<26} win-day move {st.median(w):.2f}%   no losing day')

    p('')
    p('=' * 122)
    p('  WHAT THIS DOES AND DOES NOT SAY')
    p('=' * 122)
    p('  - No premium floor and no variant reaches a 100% win rate. The best any')
    p('    of them manages is in the high nineties, and the losses that remain are')
    p('    the days BTC moved further in twelve hours than the strike was away.')
    p('  - The strategy is short a tail. Its win rate is high because most days are')
    p('    quiet, and its loss is large because the rare day is not.')
    p('  - On the most dangerous days Delta often lists no cheap strike at all, so')
    p('    the rule stands aside. Part of the win rate is that filter, not skill.')
    p('  - What the model says and what happened are not the same number. Across')
    p('    27,371 legs, where Black-Scholes claimed 95-100% the settlements came in')
    p('    at 99.58%, and where it claimed 15-20% they came in at 12.28%. It is too')
    p('    cautious about safe strikes and too generous about dangerous ones.')
    p('  - Protection is frequently unlisted at the distances this sells, so a')
    p('    bounded worst case is often unavailable. Size is the real risk control.')
    p('  - The largest effect in the data is not the strike rule at all. It is the')
    p('    calendar: Monday to Friday lost money on 3 days out of 461, worst -$0.95.')
    p('    The weekend lost on 7 of 209, worst -$8.48, and holds all six of the')
    p('    biggest losses in two years. Every year says the same thing.')
    p('  - An earlier version of this analysis said Saturday loses money. On the')
    p('    complete data it does not; it makes a little, badly. The case for standing')
    p('    aside at the weekend is about where the tail lives, not about the average.')
    p('')
    out.close()
    print(f'\nwritten: DESK-REPORT.txt', file=sys.stderr)


if __name__ == '__main__':
    main()
