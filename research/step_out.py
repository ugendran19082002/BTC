#!/usr/bin/env python3
"""When a leg fails the 95% gate, must the day be skipped -- or can you step out?

CAREFUL -- THIS FILE USES A DIFFERENT SELECTION RULE FROM THE REST.

  This one picks the richest strike whose premium is at or BELOW $15: a premium
  *cap*, the AlgoTest rule the README describes.

  Everything else in this directory reads the `paths` table, whose floor=15 rows
  hold the furthest strike still paying AT LEAST $15: a premium *floor*, the
  rule `precheck.ts` and `recommend.ts` implement.

  They are opposite rules and they select different strikes -- the cap picks
  further out and cheaper, the floor picks nearer and richer. Numbers here are
  therefore NOT comparable with BASELINE-REPORT.txt or FINAL-COMPARISON.txt.

The gate refuses a leg when the strike it selected is not safe enough. That is a statement about *that strike*, not about the day. Two other
answers exist and neither was tested:

  STEP OUT   take a further strike on the same day. It pays less than $15 and
             sits further from spot, so its probability is higher by
             construction. The floor stops being "sell $15 of premium" and
             becomes "sell as much as $15 will buy at 95% safety".

  WAIT       come back later. P(expire worthless) rises as the clock runs down
             -- d2 grows with 1/sqrt(T) -- so a leg that fails at 05:30 will
             pass at some point simply from time passing, if spot behaves. The
             premium decays while you wait, which is the cost.

This measures STEP OUT, which is real: chain.db holds every strike quoted at
05:30 with what it settled at, so the further strike and its outcome are both
on record. WAIT is discussed at the end and is not measurable here -- the
harvester captures the chain once, at 05:30, so there is no 09:00 board to
re-select from.

All four variants are scored held to settlement. The `paths` table carries
intraday decay only for the legs the $15 floor selected, so a stepped-out
strike has no decay path and the 95% target cannot be applied to it. Holding
every variant to settlement is the comparison that stays like-for-like; the
target adds about 4% to each.

  python3 research/step_out.py
"""
import json, math, os, sqlite3, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
OUT = os.path.join(HERE, 'STEP-OUT.txt')

CONTRACTS, CV, SLIP, USDINR = 10, 0.001, 0.05, 85
T12, FLOOR, GATE = 12 / 24 / 365, 15.0, 0.95


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
    days = {d: (spot, settle) for d, spot, settle in
            con.execute('SELECT date,spot,settle FROM days WHERE settle IS NOT NULL')}
    chain = {}
    for date, cp, k, mark, sv in con.execute(
            'SELECT date,cp,k,mark,settle_value FROM legs WHERE mark>0'):
        chain.setdefault(date, []).append((cp, k, mark, sv))

    # Every candidate, with its probability, per day and side.
    cand = {}
    for date, rows in chain.items():
        if date not in days:
            continue
        spot, _ = days[date]
        for cp, k, mark, sv in rows:
            otm = (k - spot) if cp == 'C' else (spot - k)
            if otm <= 0:
                continue
            v = solve_iv(cp, spot, k, T12, mark)
            if v is None:
                continue
            cand.setdefault(date, {}).setdefault(cp, []).append({
                'k': k, 'mark': mark, 'sv': sv or 0.0,
                'p': p_worthless(cp, spot, k, T12, v),
                'otm': abs(otm) / spot * 100,
            })
    dates = sorted(d for d in cand if len(cand.get(d, {})) == 2)

    def richest_under(rows, floor):
        ok = [r for r in rows if r['mark'] <= floor]
        return max(ok, key=lambda r: r['mark']) if ok else None

    def pick(date, cp, mode):
        rows = cand[date][cp]
        base = richest_under(rows, FLOOR)
        if mode == 'baseline':
            return base
        if mode == 'skip':
            return base if base and base['p'] >= GATE else None
        if mode == 'stepout':
            # richest strike that is both affordable and safe enough
            ok = [r for r in rows if r['mark'] <= FLOOR and r['p'] >= GATE]
            return max(ok, key=lambda r: r['mark']) if ok else None
        raise ValueError(mode)

    def run(mode):
        vals, sold, prem, otm, zeros = [], 0, [], [], 0
        for d in dates:
            t = 0.0
            for cp in ('C', 'P'):
                r = pick(d, cp, mode)
                if r is None:
                    continue
                t += money(r['mark'] * (1 - SLIP) - r['sv'])
                sold += 1
                prem.append(r['mark'])
                otm.append(r['otm'])
                zeros += 1 if r['sv'] == 0 else 0
            vals.append(t)
        s = stats(vals)
        s.update(sold=sold, prem=st.fmean(prem) if prem else 0,
                 otm=st.fmean(otm) if otm else 0,
                 acc=(zeros / sold * 100) if sold else 0, vals=vals)
        return s

    L = []
    w = L.append
    w('=' * 86)
    w('SKIP THE LEG, OR STEP FURTHER OUT?')
    w('=' * 86)
    w(f'  {len(dates):,} days, {dates[0]} to {dates[-1]}.  {CONTRACTS} contracts per leg,')
    w(f'  {SLIP*100:.0f}% slippage, held to settlement so all three are like-for-like.')
    w('')
    w('  BASELINE   richest strike at or below $15 (the cap rule). No gate.')
    w('  SKIP       the same strike, sold only if it is 95%+ to expire worthless.')
    w('  STEP OUT   the richest strike that is BOTH at or below $15 AND 95%+ safe.')
    w('')

    res = {m: run(m) for m in ('baseline', 'skip', 'stepout')}
    w(f'  {"":<22} {"BASELINE":>12} {"SKIP":>12} {"STEP OUT":>12}')
    w('  ' + '-' * 62)
    rowspec = [
        ('legs sold', 'sold', '{:,.0f}'),
        ('days with a trade', 'days', '{:,.0f}'),
        ('avg premium sold', 'prem', '${:.2f}'),
        ('avg distance out', 'otm', '{:.2f}%'),
        ('actual expired at 0', 'acc', '{:.2f}%'),
        ('TOTAL Rs', 'total', '{:+,.0f}'),
        ('win rate', 'win', '{:.1f}%'),
        ('profit factor', 'pf', '{:.2f}'),
        ('losing days', 'losers', '{:,.0f}'),
        ('worst day Rs', 'worst', '{:+,.0f}'),
        ('max drawdown Rs', 'mdd', '{:,.0f}'),
    ]
    for label, key, fmt in rowspec:
        cells = []
        for m in ('baseline', 'skip', 'stepout'):
            v = res[m][key]
            if key in ('total', 'worst', 'mdd'):
                v = v * USDINR
            cells.append(fmt.format(v))
        w(f'  {label:<22} {cells[0]:>12} {cells[1]:>12} {cells[2]:>12}')
    w('')

    # what stepping out actually costs, leg by leg
    stepped = same = gone = 0
    lost_prem = []
    for d in dates:
        for cp in ('C', 'P'):
            b = pick(d, cp, 'baseline')
            s = pick(d, cp, 'stepout')
            if b is None:
                continue
            if s is None:
                gone += 1
            elif s['k'] == b['k']:
                same += 1
            else:
                stepped += 1
                lost_prem.append(b['mark'] - s['mark'])
    w('=' * 86)
    w('WHAT STEPPING OUT COSTS')
    w('=' * 86)
    w(f'  the $15 strike was already safe enough   {same:>5} legs  {same/(same+stepped+gone)*100:>5.1f}%')
    w(f'  stepped to a further strike              {stepped:>5} legs  {stepped/(same+stepped+gone)*100:>5.1f}%')
    w(f'  no strike on the board qualified         {gone:>5} legs  {gone/(same+stepped+gone)*100:>5.1f}%')
    if lost_prem:
        w('')
        w(f'  when it stepped, it gave up ${st.fmean(lost_prem):.2f} of premium on average')
        w(f'  ({st.median(lost_prem):.2f} median), which is the price of the extra distance')
    w('')

    w('=' * 86)
    w('OUT OF SAMPLE')
    w('=' * 86)
    half = len(dates) // 2
    w(f'  {"":<12} {"1st half Rs":>12} {"2nd half Rs":>12} {"PF 1st":>8} {"PF 2nd":>8}')
    for m in ('baseline', 'skip', 'stepout'):
        a, b = stats(res[m]['vals'][:half]), stats(res[m]['vals'][half:])
        w(f'  {m:<12} {a["total"]*USDINR:>+12,.0f} {b["total"]*USDINR:>+12,.0f} '
          f'{a["pf"]:>8.2f} {b["pf"]:>8.2f}')
    w('')

    w('=' * 86)
    w('AT EQUAL RISK')
    w('=' * 86)
    base = res['baseline']
    w(f'  {"":<12} {"SIZE x":>8} {"TOTAL Rs":>12} {"vs BASE":>9}')
    for m in ('baseline', 'skip', 'stepout'):
        r = res[m]
        if r['mdd'] <= 0:
            continue
        sc = base['mdd'] / r['mdd']
        w(f'  {m:<12} {sc:>7.2f}x {r["total"]*sc*USDINR:>+12,.0f} '
          f'{(r["total"]*sc/base["total"]-1)*100:>+8.0f}%')
    w('')

    w('=' * 86)
    w('AND WAITING?')
    w('=' * 86)
    w('  P(expire worthless) climbs on its own as the day runs out -- d2 carries')
    w('  a 1/sqrt(T), so the same strike that reads 92% at 05:30 will read 95% a')
    w('  few hours later provided spot has not moved against it. So yes: a leg')
    w('  refused at 05:30 can be taken later, and the day need never be skipped.')
    w('')
    w('  What it costs is the premium, which decays over exactly those hours, and')
    w('  the two do not move at the same rate. It is a real strategy and it is')
    w('  NOT measurable here: the harvester captures the chain once, at 05:30, so')
    w('  there is no later board to re-select a strike from. Adding a second')
    w('  snapshot to harvest_chain.py is what would settle it.')
    w('')
    w('  STEP OUT needs no such wait. It takes the extra distance immediately, at')
    w('  05:30, out of the same board -- which is why it is the one measured here.')
    w('=' * 86)

    text = '\n'.join(L) + '\n'
    open(OUT, 'w').write(text)
    print(text)
    print(f'wrote -> {OUT}')


if __name__ == '__main__':
    main()
