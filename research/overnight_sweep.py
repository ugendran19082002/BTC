#!/usr/bin/env python3
"""Does the overnight trade work if you sell a cheaper option?

Every earlier overnight test sold $30 of premium and lost about Rs 15,200
whichever exit rule it used. The claim that came out of that was: the premium
level is the problem, not the hour -- $30 sits 2.2% from spot, and the day
strategy's $15 floor sits much further out.

This sweeps the premium cap to test that claim rather than assert it, at the
cap the question was asked about ($10) and the ones on either side.

Selection follows the strategy's own convention: the richest strike at or below
the cap, the same rule `Premium <= 15` uses in the README.

Two exit modes, because "23:30 to 05:00" can mean either:

  WINDOW   close at 05:00 whatever has happened. A true overnight trade -- you
           are flat before the day contract is even chosen.
  HOLD     close at the target if it is reached, otherwise ride to the 17:30
           settlement. This is what the earlier tests did.

READ THIS BEFORE BELIEVING ANY NUMBER BELOW
---------------------------------------------------------------------------
These are modelled, not measured. There are no option quotes at 23:30 IST
anywhere in this data -- chain.db records 05:30 and settlement only -- so the
entry price, the exit price and everything between them come out of
Black-Scholes on the real five-minute spot path.

That makes every total here a function of one number nobody has measured: the
implied vol at 23:30. And the results are not mildly sensitive to it, they are
governed by it. Selling a $10 option at 23:30 and buying it back at 05:00, with
no slippage at all, over 973 days:

    IV used    strike sits    net per leg    total
     36.8%         3.54%        -7.5567     Rs -12,500
     40.0%         3.89%        -4.6892     Rs  -7,756
     42.4%         4.15%        -2.9653     Rs  -4,905
     45.0%         4.45%        -1.5640     Rs  -2,587
     48.0%         4.78%        -0.2200     Rs    -364

The vol decides the strike, and the strike decides everything. At 36.8% -- the
figure solved from one real Delta ticket, and the figure the sweep below uses --
the model puts the strike 3.54% out and loses Rs 12,500 before a single cost is
charged. At 48% it puts the same $10 of premium 4.78% out and is a coin flip.

BTC actually realised **42.4%** over the 23:30-05:00 window and 41.0% over the
day window, against the 36.8% used here. So the sweep sells options too cheap
into a market that moves more than it was told, which is a guaranteed loser and
has nothing to do with the hour or the premium cap. Fat tails push the
break-even higher still: lognormal underprices the wings, which is why the
table above only reaches zero near 48%.

**So the sweep below cannot show that the overnight trade loses money. It shows
that a mispriced short option loses money, which was never in doubt.** The
question stays open until real 23:30 quotes exist -- one snapshot added to
harvester/harvest_chain.py, and a few months of waiting.

The 05:30 results elsewhere in this directory are unaffected: those read real
entry marks, real settle values and real decay paths out of chain.db, and never
touch this model.

  python3 research/overnight_sweep.py
"""
import datetime, json, math, os, statistics as st, zoneinfo

IST = zoneinfo.ZoneInfo('Asia/Kolkata')
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache-5m.json')

CONTRACTS, CV, SLIP, USDINR, IV = 10, 0.001, 0.05, 85, 0.368
CAPS = [10, 15, 20, 30]
TARGETS = [(0.3, '70%'), (0.5, '50%'), (0.1, '90%')]
CLOSE_STEP = 66          # 05:00 IST = 330 minutes after 23:30, in 5-minute steps


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


def pick_strike(cp, s, t, cap):
    """Richest strike at or below the cap, on Delta's 200-point grid."""
    base = int(s / 200) * 200
    best = None
    for j in range(160):
        k = base + j * 200 if cp == 'C' else base - j * 200
        if k <= 0:
            break
        p = bs(cp, s, k, t, IV)
        if p <= cap:
            return k, p
        best = (k, p)
    return best


def walk():
    """One pass per (day, leg, cap): value at 05:00, when each target was hit,
    and the settlement payoff. Every exit rule is then arithmetic on this."""
    bars = {int(t): b for t, b in json.load(open(CACHE)).items()}
    slot = {}
    for t, b in bars.items():
        d = datetime.datetime.fromtimestamp(t, IST)
        slot[(d.date(), d.hour, d.minute - d.minute % 5)] = b['close']
    dates = sorted({d for d, _, _ in slot})

    rec = {c: {} for c in CAPS}
    for i, d in enumerate(dates[:-1]):
        nxt = dates[i + 1]
        if (nxt - d).days != 1:
            continue
        s0 = slot.get((d, 23, 30))
        s_end = slot.get((nxt, 17, 30))
        if s0 is None or s_end is None:
            continue
        t_in = 18 / 24 / 365
        for cap in CAPS:
            legs = []
            ok = True
            for cp in ('C', 'P'):
                got = pick_strike(cp, s0, t_in, cap)
                if got is None:
                    ok = False
                    break
                k, entry = got
                if entry <= 0:
                    ok = False
                    break
                first = {}
                at_close = None
                for step in range(1, 217):
                    mins = step * 5
                    hh, mm = divmod((23 * 60 + 30 + mins) % 1440, 60)
                    dd = d if (23 * 60 + 30 + mins) < 1440 else nxt
                    s = slot.get((dd, hh, mm - mm % 5))
                    if s is None:
                        continue
                    val = bs(cp, s, k, max((18 * 60 - mins) / 60 / 24 / 365, 0), IV)
                    for frac, _ in TARGETS:
                        if frac not in first and val <= entry * frac:
                            first[frac] = step
                    if step == CLOSE_STEP:
                        at_close = val
                if at_close is None:
                    ok = False
                    break
                settle = max(0.0, (s_end - k) if cp == 'C' else (k - s_end))
                legs.append({'entry': entry, 'first': first,
                             'close': at_close, 'settle': settle})
            if ok:
                rec[cap][str(nxt)] = legs
    return rec


def score(legs_by_date, frac, mode):
    out, hit, tot = {}, 0, 0
    for date, legs in legs_by_date.items():
        day = 0.0
        for L in legs:
            tot += 1
            credit = L['entry'] * (1 - SLIP)
            step = L['first'].get(frac)
            if step is not None and (mode == 'hold' or step <= CLOSE_STEP):
                hit += 1
                exit_px = L['entry'] * frac * (1 + SLIP)
            elif mode == 'window':
                exit_px = L['close'] * (1 + SLIP)      # closing is a purchase
            else:
                exit_px = L['settle']                  # settlement costs nothing
            day += money(credit - exit_px)
        out[date] = day
    return out, hit / max(tot, 1)


def stats(series, dates):
    v = [series[d] for d in dates]
    wins = [x for x in v if x > 0]
    gl = -sum(x for x in v if x <= 0)
    eq = peak = mdd = 0.0
    for x in v:
        eq += x
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)
    return (sum(v), st.fmean(v), len(wins) / len(v) * 100,
            min(v), mdd, (sum(wins) / gl) if gl else float('inf'))


def main():
    rec = walk()
    dates = sorted(set.intersection(*[set(rec[c]) for c in CAPS]))
    print('=' * 92)
    print('OVERNIGHT 23:30 -> 05:00 : DOES A CHEAPER OPTION FIX IT?')
    print('=' * 92)
    print(f'  {len(dates):,} days, {dates[0]} to {dates[-1]}   {CONTRACTS} contracts per leg, CE + PE')
    print('  MODELLED -- no option quotes exist at 23:30 IST in any of this data.\n')

    print(f'  {"CAP":>4} {"TARGET":>7} {"MODE":>7} {"HIT":>6} {"TOTAL Rs":>11} {"PER DAY":>9} '
          f'{"WIN%":>6} {"WORST Rs":>10} {"MAXDD Rs":>10} {"PF":>6}')
    print('  ' + '-' * 88)
    rows = []
    for cap in CAPS:
        for frac, label in TARGETS:
            for mode in ('window', 'hold'):
                s, h = score(rec[cap], frac, mode)
                tot, avg, win, worst, mdd, pf = stats(s, dates)
                rows.append((tot, cap, label, mode))
                print(f'  {"$"+str(cap):>4} {label:>7} {mode:>7} {h*100:>5.1f}% '
                      f'{tot*USDINR:>+11,.0f} {avg*USDINR:>+9.2f} {win:>5.1f}% '
                      f'{worst*USDINR:>+10,.0f} {mdd*USDINR:>10,.0f} {pf:>6.2f}')
        print()

    print('=' * 92)
    print('BEST FIRST')
    print('=' * 92)
    for tot, cap, label, mode in sorted(rows, reverse=True)[:6]:
        print(f'  ${cap} cap, {label} target, {mode:<6}  Rs {tot*USDINR:+,.0f}')

    print('\n  THE QUESTION ASKED:  $10 cap, 70% target, closed at 05:00')
    s, h = score(rec[10], 0.3, 'window')
    tot, avg, win, worst, mdd, pf = stats(s, dates)
    print(f'    total Rs {tot*USDINR:+,.0f}   per day Rs {avg*USDINR:+.2f}   win {win:.1f}%   '
          f'target hit {h*100:.1f}%')
    print(f'    worst day Rs {worst*USDINR:+,.0f}   max drawdown Rs {mdd*USDINR:,.0f}   PF {pf:.2f}')
    print('\n  For scale: the 05:30 $15 day trade at a 95% target makes Rs +15,225')
    print('  over the same days, measured rather than modelled.')

    print('\n' + '=' * 92)
    print('WHY EVERY ROW IS NEGATIVE  -- read this before using any of it')
    print('=' * 92)
    print(f'  This model priced every option at {IV*100:.1f}% implied vol, solved from one real')
    print('  Delta ticket. Over the same days BTC actually realised 42.4% between')
    print('  23:30 and 05:00, and 41.0% across the day window.')
    print()
    print('  Selling at 36.8% into a market that moves at 42.4% loses money by')
    print('  construction. With zero slippage and no exit rule at all, the $10')
    print('  overnight leg still loses Rs 12,500 -- which is more than any row above.')
    print('  The vol assumption, not the hour and not the premium cap, is doing the work:')
    print()
    print('     IV 36.8% -> strike 3.54% out -> Rs -12,500')
    print('     IV 42.4% -> strike 4.15% out -> Rs  -4,905')
    print('     IV 48.0% -> strike 4.78% out -> Rs    -364')
    print()
    print('  So this sweep does NOT show the overnight trade is unprofitable. It shows')
    print('  an underpriced short option is unprofitable. The real market quotes these')
    print('  wings on a smile, well above ATM vol, and this flat-IV model does not.')
    print()
    print('  To settle it properly, harvest a 23:30 IST snapshot in harvest_chain.py')
    print('  and measure it the way the 05:30 leg is measured.')


if __name__ == '__main__':
    main()
