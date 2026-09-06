#!/usr/bin/env python3
"""Does a minimum premium of $N ever give a 100% win rate?

Reads chain.db. Every position is opened at 05:30 IST on the option's own
expiry day and held to the 12:00 UTC settlement, so the exit is exact intrinsic
value -- no exit-quote guesswork.

  python3 study_premium.py [> STUDY-PREMIUM-FLOOR.txt]
"""
import store, datetime, statistics as st

LOT = 0.001          # BTC per contract
LOTS = 10
SLIP = 0.05
USDINR = 85.0
FLOORS = [0, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100]


def load():
    con = store.connect(readonly=True)
    days = {}
    for d in con.execute('SELECT * FROM days ORDER BY date'):
        days[d['date']] = {'date': d['date'], 'spot': d['spot'], 'settle': d['settle'],
                           'atm': d['atm'], 'legs': []}
    for l in con.execute('SELECT * FROM legs'):
        if l['date'] in days and l['mark'] is not None:
            days[l['date']]['legs'].append(dict(l))
    con.close()
    return [v for v in days.values() if v['legs']]


def otm(day, cp):
    return [l for l in day['legs']
            if l['cp'] == cp and (l['k'] > day['atm'] if cp == 'C' else l['k'] < day['atm'])]


def pick_floor(day, cp, floor):
    """The furthest strike that still pays at least `floor`. This is what a
    seller asking for 'at least $N' actually wants: the most distance the
    market will give them at that price."""
    c = [l for l in otm(day, cp) if l['mark'] >= floor]
    return min(c, key=lambda l: l['mark']) if c else None


def pnl(leg):
    entry = leg['mark'] * (1 - SLIP)
    return (entry - leg['settle_value']) * LOTS * LOT


def stats(rows):
    if not rows:
        return None
    tot = sum(r['pnl'] for r in rows)
    wins = [r for r in rows if r['pnl'] > 0]
    loss = [r for r in rows if r['pnl'] < 0]
    gw = sum(r['pnl'] for r in wins)
    gl = -sum(r['pnl'] for r in loss)
    peak = cum = mdd = 0.0
    for r in rows:
        cum += r['pnl']
        peak = max(peak, cum)
        mdd = max(mdd, peak - cum)
    worst = min(rows, key=lambda r: r['pnl'])
    return {
        'n': len(rows), 'win': 100 * len(wins) / len(rows), 'total': tot,
        'pf': (gw / gl) if gl > 0 else float('inf'),
        'worst': worst['pnl'], 'worst_date': worst['date'],
        'mdd': mdd, 'avg': tot / len(rows), 'losses': len(loss),
    }


def line(tag, s):
    if s is None:
        return f'{tag:<22} {"no tradeable day":>50}'
    pf = '   inf' if s['pf'] == float('inf') else f"{s['pf']:6.2f}"
    return (f"{tag:<22} {s['n']:>4}d  win {s['win']:5.1f}%  "
            f"tot ${s['total']:8.2f}  ₹{s['total']*USDINR:8.0f}  PF {pf}  "
            f"worst ${s['worst']:7.2f} ({s['worst_date']})  MDD ${s['mdd']:6.2f}")


def main():
    days = load()
    print('=' * 118)
    print('  MINIMUM-PREMIUM STUDY -- is there a strike that never loses?')
    print('=' * 118)
    print(f"  data      : {len(days)} expiry days, {days[0]['date']} .. {days[-1]['date']}")
    print(f"  entry     : 05:30 IST mark price, {SLIP:.0%} slippage, {LOTS} lots ({LOTS*LOT} BTC)")
    print(f"  exit      : settlement intrinsic at 12:00 UTC (exact)")
    print(f"  selection : the FURTHEST out-of-the-money strike still paying the floor")
    print()

    print('-' * 118)
    print('  1. PREMIUM FLOOR SWEEP -- CE and PE sold together')
    print('-' * 118)
    for f in FLOORS:
        rows = []
        for d in days:
            legs = [pick_floor(d, cp, f) for cp in 'CP']
            legs = [l for l in legs if l]
            if not legs:
                continue
            rows.append({'date': d['date'], 'pnl': sum(pnl(l) for l in legs)})
        print(line(f'floor ${f}', stats(rows)))

    for cp, name in (('C', 'CE only'), ('P', 'PE only')):
        print()
        print('-' * 118)
        print(f'  2. PREMIUM FLOOR SWEEP -- {name}')
        print('-' * 118)
        for f in FLOORS:
            rows = []
            for d in days:
                l = pick_floor(d, cp, f)
                if l:
                    rows.append({'date': d['date'], 'pnl': pnl(l)})
            print(line(f'{name} floor ${f}', stats(rows)))

    print()
    print('-' * 118)
    print('  3. WHERE DOES THE FLOOR PUT YOU? distance of the chosen strike')
    print('-' * 118)
    print(f"  {'floor':>6}  {'CE strikes OTM':>15}  {'CE % from spot':>15}  "
          f"{'PE strikes OTM':>15}  {'PE % from spot':>15}")
    for f in FLOORS:
        ce_off, pe_off, ce_pct, pe_pct = [], [], [], []
        for d in days:
            c = pick_floor(d, 'C', f)
            p = pick_floor(d, 'P', f)
            if c:
                ce_off.append(abs(c['off'])); ce_pct.append(100 * (c['k'] - d['spot']) / d['spot'])
            if p:
                pe_off.append(abs(p['off'])); pe_pct.append(100 * (d['spot'] - p['k']) / d['spot'])
        def m(x):
            return f'{st.median(x):.1f}' if x else '-'
        print(f"  ${f:>5}  {m(ce_off):>15}  {m(ce_pct):>15}  {m(pe_off):>15}  {m(pe_pct):>15}")

    print()
    print('-' * 118)
    print('  4. THE LOSING DAYS AT A $15 FLOOR -- every one of them')
    print('-' * 118)
    rows = []
    for d in days:
        legs = [(cp, pick_floor(d, cp, 15)) for cp in 'CP']
        legs = [(cp, l) for cp, l in legs if l]
        if not legs:
            continue
        rows.append({'date': d['date'], 'spot': d['spot'], 'settle': d['settle'],
                     'legs': legs, 'pnl': sum(pnl(l) for _, l in legs)})
    bad = sorted([r for r in rows if r['pnl'] < 0], key=lambda r: r['pnl'])
    print(f"  {len(bad)} losing days out of {len(rows)} traded "
          f"({100*len(bad)/len(rows):.1f}%)")
    print()
    for r in bad[:25]:
        wd = datetime.date.fromisoformat(r['date']).strftime('%a')
        move = 100 * (r['settle'] - r['spot']) / r['spot']
        legdesc = '  '.join(
            f"{cp}E {l['k']} @{l['mark']:.1f} ->{l['settle_value']:.0f}" for cp, l in r['legs'])
        print(f"  {r['date']} {wd}  spot {r['spot']:>9.0f} -> {r['settle']:>9.0f} "
              f"({move:+5.2f}%)  ${r['pnl']:7.2f}  ₹{r['pnl']*USDINR:7.0f}   {legdesc}")

    print()
    print('-' * 118)
    print('  5. WHAT A LOSING DAY LOOKS LIKE -- BTC move vs the floor')
    print('-' * 118)
    moves = [abs(100 * (r['settle'] - r['spot']) / r['spot']) for r in rows]
    badmoves = [abs(100 * (r['settle'] - r['spot']) / r['spot']) for r in bad]
    print(f"  median 12h move on a winning day : {st.median([m for m,r in zip(moves,rows) if r['pnl']>=0]):.2f}%")
    if badmoves:
        print(f"  median 12h move on a losing day  : {st.median(badmoves):.2f}%")
        print(f"  largest 12h move in the sample   : {max(moves):.2f}%")

    print()
    print('-' * 118)
    print('  6. HEDGING THE $15 FLOOR -- what a capped worst case costs')
    print('-' * 118)
    print(f"  {'hedge':<22} {'':>4}   {'':>10}  {'':>18}  {'':>10}")
    for gap in (0, 2, 3, 5, 8):
        rows = []
        capped = []
        for d in days:
            by = {(l['cp'], l['k']): l for l in d['legs']}
            legs = []
            ok = True
            for cp in 'CP':
                short = pick_floor(d, cp, 15)
                if not short:
                    continue
                p = pnl(short)
                if gap:
                    hk = short['k'] + gap * 200 if cp == 'C' else short['k'] - gap * 200
                    h = by.get((cp, hk))
                    if h is None:
                        ok = False       # protection unavailable at that distance
                    else:
                        # long leg: pay the mark plus slippage, collect its settlement
                        p += (h['settle_value'] - h['mark'] * (1 + SLIP)) * LOTS * LOT
                legs.append(p)
            if not legs:
                continue
            rows.append({'date': d['date'], 'pnl': sum(legs)})
            capped.append(ok)
        s6 = stats(rows)
        tag = 'naked' if gap == 0 else f'buy {gap} strikes out'
        cover = 100 * sum(capped) / len(capped) if capped else 0
        print(line(tag, s6) + (f'  covered {cover:.0f}%' if gap else ''))
    print()
    print('  A hedge that is not listed cannot be bought. "covered" is the share of')
    print('  days a strike existed at that distance; on the rest the leg stayed naked.')

    print()
    print('-' * 118)
    print('  7. DAY OF WEEK AT THE $15 FLOOR')
    print('-' * 118)
    names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    byday = {i: [] for i in range(7)}
    for d in days:
        legs = [pick_floor(d, cp, 15) for cp in 'CP']
        legs = [l for l in legs if l]
        if not legs:
            continue
        wd = datetime.date.fromisoformat(d['date']).weekday()
        byday[wd].append({'date': d['date'], 'pnl': sum(pnl(l) for l in legs)})
    for i in range(7):
        print(line(names[i], stats(byday[i])))
    allrows = [r for i in range(7) for r in byday[i]]
    nosat = [r for i in range(7) if i != 5 for r in byday[i]]
    print()
    print(line('ALL DAYS', stats(sorted(allrows, key=lambda r: r['date']))))
    print(line('WITHOUT SATURDAY', stats(sorted(nosat, key=lambda r: r['date']))))
    print()


if __name__ == '__main__':
    main()
