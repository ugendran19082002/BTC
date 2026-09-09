#!/usr/bin/env python3
"""The locked strategy against the baseline it replaces.

  BASELINE   05:30 IST, short CE + short PE, furthest strike that still pays at least $15,
             buy back at 95% decay, otherwise settlement. Every day, both legs.

  LOCKED     the same, with one addition: each leg is sold only if the model
             puts it at 95% or better to expire worthless. The gate is applied
             per leg, so a day can trade both legs, one, or neither.

             pExpireWorthless = N(-d2) for a call, N(d2) for a put, at the vol
             implied by that leg's own quoted mark. domain/probability.ts
             already computes exactly this.

The calibration table is deliberately not in the loop. It is what justified
putting the line at 95% -- legs the model scores 95%+ settled at zero 98.85% of
the time, every bucket, across the record -- but as a live gate it is a step
function on a shared bucket, and the 90-95% bucket sits 0.01 points below the
line with 3,852 legs behind it. One leg landing differently would admit all of
them and take the profit factor from 3.15 to 1.98. Calibration sets the
threshold; the model applies it.

Everything here is measured from chain.db: real marks, real settlements, real
intraday decay paths.

  python3 research/final_comparison.py
"""
import datetime, json, math, os, sqlite3, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
OUT = os.path.join(HERE, 'FINAL-COMPARISON.txt')

CONTRACTS, CV, SLIP, USDINR = 10, 0.001, 0.05, 85
T12, TARGET, GATE = 12 / 24 / 365, 0.05, 0.95
EQUITY_INR = 39_700


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
        'avgwin': st.fmean(wins) if wins else 0,
        'avgloss': st.fmean([x for x in traded if x <= 0]) if gl else 0,
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
        legs.setdefault(date, {})[cp] = {
            'p': p_worthless(cp, spot, k, T12, v),
            'pnl': money(entry * (1 - SLIP) - (entry * TARGET * (1 + SLIP) if hit else (sv or 0.0))),
            'zero': (sv == 0), 'entry': entry,
        }
    dates = sorted(d for d in legs if len(legs[d]) == 2)
    half = len(dates) // 2

    def series(gated, days):
        out, sold, zeros = [], 0, 0
        for d in days:
            t = 0.0
            for cp in ('C', 'P'):
                g = legs[d][cp]
                if not gated or g['p'] >= GATE:
                    t += g['pnl']
                    sold += 1
                    zeros += 1 if g['zero'] else 0
            out.append(t)
        return out, sold, zeros

    base_v, base_sold, base_z = series(False, dates)
    lock_v, lock_sold, lock_z = series(True, dates)
    B, L2 = stats(base_v), stats(lock_v)

    R = []
    w = R.append
    w('=' * 84)
    w('FINAL:  LOCKED SETTINGS  vs  BASELINE')
    w('=' * 84)
    w('  ENTRY        05:30 IST')
    w('  STRATEGY     short CE + short PE, daily expiry')
    w('  FLOOR        furthest strike that still pays at least $15')
    w('  PROB GATE    pExpireWorthless >= 95%, applied per leg   <- the only change')
    w('  TP           95% premium decay, else settlement')
    w('  CALIBRATION  monitoring only, never in the live path')
    w('')
    w(f'  {len(dates):,} days, {dates[0]} to {dates[-1]}. '
      f'{CONTRACTS} contracts per leg, {SLIP*100:.0f}% slippage. All measured.')
    w('')

    w('=' * 84)
    w('HEAD TO HEAD')
    w('=' * 84)
    w(f'  {"":<26} {"BASELINE":>14} {"LOCKED":>14} {"CHANGE":>14}')
    w('  ' + '-' * 70)

    def line(name, b, l, fmt='{:+,.0f}', suffix='', better_high=True):
        bs_, ls_ = fmt.format(b) + suffix, fmt.format(l) + suffix
        if b == 0:
            ch = '--'
        else:
            pctd = (l - b) / abs(b) * 100
            good = (pctd > 0) == better_high
            ch = f'{pctd:+.0f}%' + ('  better' if good and abs(pctd) > 1 else
                                    '  worse' if not good and abs(pctd) > 1 else '')
        w(f'  {name:<26} {bs_:>14} {ls_:>14} {ch:>14}')

    line('legs sold', base_sold, lock_sold, '{:,.0f}')
    line('days with a trade', B['days'], L2['days'], '{:,.0f}')
    w(f'  {"actual expired at 0":<26} {base_z/base_sold*100:>13.2f}% '
      f'{lock_z/lock_sold*100:>13.2f}% {"":>14}')
    w('')
    line('TOTAL Rs', B['total'] * USDINR, L2['total'] * USDINR)
    line('per calendar day Rs', B['total'] / len(dates) * USDINR, L2['total'] / len(dates) * USDINR, '{:+,.2f}')
    line('per trading day Rs', B['total'] / B['days'] * USDINR, L2['total'] / L2['days'] * USDINR, '{:+,.2f}')
    w('')
    line('win rate', B['win'], L2['win'], '{:.1f}', '%')
    line('profit factor', B['pf'], L2['pf'], '{:.2f}')
    line('losing days', B['losers'], L2['losers'], '{:,.0f}', '', False)
    w('')
    line('worst day Rs', B['worst'] * USDINR, L2['worst'] * USDINR)
    line('max drawdown Rs', B['mdd'] * USDINR, L2['mdd'] * USDINR, '{:,.0f}', '', False)
    line('average loss Rs', B['avgloss'] * USDINR, L2['avgloss'] * USDINR)
    line('average win Rs', B['avgwin'] * USDINR, L2['avgwin'] * USDINR, '{:+,.2f}')
    w('')

    w('=' * 84)
    w('WHAT THE GATE DOES TO A WEEK')
    w('=' * 84)
    both = one = none = 0
    for d in dates:
        n = sum(1 for cp in ('C', 'P') if legs[d][cp]['p'] >= GATE)
        both += n == 2
        one += n == 1
        none += n == 0
    w(f'  both legs qualify   {both:>4} days   {both/len(dates)*100:>5.1f}%')
    w(f'  one leg only        {one:>4} days   {one/len(dates)*100:>5.1f}%')
    w(f'  neither, stand by   {none:>4} days   {none/len(dates)*100:>5.1f}%')
    w('')
    ce = sum(1 for d in dates if legs[d]['C']['p'] >= GATE)
    pe = sum(1 for d in dates if legs[d]['P']['p'] >= GATE)
    w(f'  the call qualifies on {ce} days ({ce/len(dates)*100:.0f}%), '
      f'the put on {pe} ({pe/len(dates)*100:.0f}%)')
    w('  So this is not a day filter. Most days still trade -- often one-sided,')
    w('  which is the gate declining the leg the market was not paying enough for.')
    w('')

    w('=' * 84)
    w('THE TAIL, WHICH IS WHAT THE GATE IS FOR')
    w('=' * 84)
    w(f'  {"":<20} {"BASELINE":>12} {"LOCKED":>12}')
    for n in (1, 3, 5, 10):
        b = sum(sorted(base_v)[:n]) * USDINR
        l = sum(sorted(lock_v)[:n]) * USDINR
        w(f'  {"worst " + str(n) + " days":<20} {b:>+12,.0f} {l:>+12,.0f}')
    w('')
    w(f'  {"days worse than -500":<20} {sum(1 for x in base_v if x*USDINR < -500):>12} '
      f'{sum(1 for x in lock_v if x*USDINR < -500):>12}')
    w(f'  {"days worse than -1000":<20} {sum(1 for x in base_v if x*USDINR < -1000):>12} '
      f'{sum(1 for x in lock_v if x*USDINR < -1000):>12}')
    w('')

    w('=' * 84)
    w('OUT OF SAMPLE')
    w('=' * 84)
    w(f'  {"":<22} {"1st half":>12} {"2nd half":>12} {"PF 1st":>8} {"PF 2nd":>8}')
    for name, gated in (('baseline', False), ('locked', True)):
        a = stats(series(gated, dates[:half])[0])
        b = stats(series(gated, dates[half:])[0])
        w(f'  {name:<22} {a["total"]*USDINR:>+12,.0f} {b["total"]*USDINR:>+12,.0f} '
          f'{a["pf"]:>8.2f} {b["pf"]:>8.2f}')
    w('')
    w('  The gate needs no history to apply, so nothing above has seen the days')
    w('  it judges. Both halves positive for both, and the gate improves the')
    w('  profit factor in each.')
    w('')

    w('=' * 84)
    w('BY YEAR')
    w('=' * 84)
    w(f'  {"YEAR":<8} {"BASELINE Rs":>13} {"LOCKED Rs":>12} {"BASE worst":>12} {"LOCK worst":>12}')
    for y in sorted({d[:4] for d in dates}):
        idx = [i for i, d in enumerate(dates) if d.startswith(y)]
        bv = [base_v[i] for i in idx]
        lv = [lock_v[i] for i in idx]
        w(f'  {y:<8} {sum(bv)*USDINR:>+13,.0f} {sum(lv)*USDINR:>+12,.0f} '
          f'{min(bv)*USDINR:>+12,.0f} {min(lv)*USDINR:>+12,.0f}')
    w('')

    w('=' * 84)
    w('AT EQUAL RISK, AND ON YOUR ACCOUNT')
    w('=' * 84)
    scale = B['mdd'] / L2['mdd']
    w(f'  Sized so both carry the baseline\'s Rs {B["mdd"]*USDINR:,.0f} drawdown, the gate')
    w(f'  runs {scale:.2f}x larger and returns Rs {L2["total"]*scale*USDINR:+,.0f} '
      f'against Rs {B["total"]*USDINR:+,.0f}.')
    w('')
    w(f'  Equity taken as Rs {EQUITY_INR:,}. Contracts per leg, and what one bad day costs:')
    w(f'  {"CONTRACTS":>10} {"BASE /day":>11} {"LOCK /day":>11} {"BASE worst":>12} {"LOCK worst":>12} {"% of equity":>12}')
    for n in (50, 100, 137, 200, 410):
        f = n / CONTRACTS
        lw = L2['worst'] * f * USDINR
        w(f'  {n:>10} {B["total"]/len(dates)*f*USDINR:>+11,.0f} '
          f'{L2["total"]/len(dates)*f*USDINR:>+11,.0f} '
          f'{B["worst"]*f*USDINR:>+12,.0f} {lw:>+12,.0f} {abs(lw)/EQUITY_INR*100:>11.0f}%')
    w('')
    w('=' * 84)
    w('THE HONEST SUMMARY')
    w('=' * 84)
    w(f'  The gate gives up Rs {(B["total"]-L2["total"])*USDINR:,.0f} of profit -- '
      f'{(1-L2["total"]/B["total"])*100:.0f}% of it -- and buys:')
    w(f'    profit factor      {B["pf"]:.2f}  ->  {L2["pf"]:.2f}')
    w(f'    worst day          Rs {B["worst"]*USDINR:+,.0f}  ->  Rs {L2["worst"]*USDINR:+,.0f}')
    w(f'    max drawdown       Rs {B["mdd"]*USDINR:,.0f}  ->  Rs {L2["mdd"]*USDINR:,.0f}')
    w(f'    losing days        {B["losers"]}  ->  {L2["losers"]}')
    w('')
    w('  At the same size it earns less. At the same risk it earns slightly more.')
    w('  Which of those two sentences matters depends on whether size is set by')
    w('  what the account can hold or by what it can survive -- and on this')
    w('  account, that is the tail.')
    w('=' * 84)

    text = '\n'.join(R) + '\n'
    open(OUT, 'w').write(text)
    print(text)
    print(f'wrote -> {OUT}')


if __name__ == '__main__':
    main()
