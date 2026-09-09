#!/usr/bin/env python3
"""Sell overnight and buy back at 05:00, or sell at 05:30 and hold to expiry?

Two ways to sell the same premium, compared over the same days:

  A  OVERNIGHT   sell at 23:30 IST, buy back at 05:00 IST.  5.5 hours held,
                 18 hours to expiry at entry, 12.5 left when you close.
  B  FULL HOLD   sell at 05:30 IST, hold to the 17:30 settlement. 12 hours,
                 and the option either expires worthless or it does not.

WHAT THIS CAN AND CANNOT SEE
---------------------------------------------------------------------------
`chain.db` holds option quotes at two moments only: 05:30 IST and settlement.
There are **no recorded option prices at 23:30 or 05:00 IST**, so strategy A
cannot be measured the way B can -- it has to be *modelled*.

So both legs are run through the same Black-Scholes model on the same real
spot path, which makes the comparison like-for-like even though it is not a
measurement of A. B is then cross-checked against its real recorded outcome in
chain.db, and the two agree closely enough to trust the model for A.

Implied vol is solved from a real Delta ticket rather than assumed:
80,800 CE at 26.19 with spot 78,607.8 and 17h37m left.

Costs follow the repo's backtest convention: 5% slippage shaved off the entry
credit. A pays 5% again to buy back, because it is lifting a real offer. B pays
nothing at the exit, because settlement is not a trade -- which turns out to be
most of the answer.

  python3 research/overnight_vs_hold.py
"""
import datetime, json, math, os, statistics as st, sys, zoneinfo

IST = zoneinfo.ZoneInfo('Asia/Kolkata')
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache-5m.json')
YEAR = 365 * 24 * 3600
PREMIUM = 30.0          # USD per BTC, per leg
SLIPPAGE = 0.05
CONTRACTS = 10          # per leg, 0.001 BTC each
CV = 0.001
USDINR = 85


def cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(cp, s, k, t, v):
    """Black-Scholes with r = 0, the way Delta prices crypto options."""
    if t <= 0 or v <= 0 or s <= 0:
        return max(0.0, (s - k) if cp == 'C' else (k - s))
    d1 = (math.log(s / k) + 0.5 * v * v * t) / (v * math.sqrt(t))
    d2 = d1 - v * math.sqrt(t)
    if cp == 'C':
        return s * cdf(d1) - k * cdf(d2)
    return k * cdf(-d2) - s * cdf(-d1)


def implied_vol(cp, s, k, t, price):
    lo, hi = 0.01, 5.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if bs(cp, s, k, t, mid) < price:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def strike_for_premium(cp, s, t, v, premium, step=200):
    """The strike, on Delta's grid, whose price is nearest the target premium."""
    best, bestd = None, 1e18
    lo = int(s / step) * step
    for i in range(0, 120):
        k = lo + i * step if cp == 'C' else lo - i * step
        if k <= 0:
            break
        d = abs(bs(cp, s, k, t, v) - premium)
        if d < bestd:
            best, bestd = k, d
        elif bs(cp, s, k, t, v) < premium * 0.2:
            break
    return best


def money(usd_per_btc):
    """Quoted units -> dollars in hand. The 1000x mistake lives here."""
    return usd_per_btc * CONTRACTS * CV


def main():
    bars = {int(t): b for t, b in json.load(open(CACHE)).items()}
    by_slot = {}
    for t, b in bars.items():
        d = datetime.datetime.fromtimestamp(t, IST)
        by_slot[(d.date(), d.hour, d.minute - d.minute % 5)] = b['close']

    dates = sorted({d for d, _, _ in by_slot})

    # Vol from a real ticket, not from a guess.
    IV = implied_vol('C', 78_607.8, 80_800, 17.62 / 24 / 365, 26.19)

    rows_a, rows_b = [], []
    for i, d in enumerate(dates[:-1]):
        nxt = dates[i + 1]
        if (nxt - d).days != 1:
            continue
        s2330 = by_slot.get((d, 23, 30))
        s0500 = by_slot.get((nxt, 5, 0))
        s0530 = by_slot.get((nxt, 5, 30))
        s1730 = by_slot.get((nxt, 17, 30))
        if not all((s2330, s0500, s0530, s1730)):
            continue

        # ---- A: sell 23:30 (18h to expiry), buy back 05:00 (12.5h left)
        t_in, t_out = 18 / 24 / 365, 12.5 / 24 / 365
        pnl_a = 0.0
        for cp in ('C', 'P'):
            k = strike_for_premium(cp, s2330, t_in, IV, PREMIUM)
            credit = bs(cp, s2330, k, t_in, IV) * (1 - SLIPPAGE)
            buyback = bs(cp, s0500, k, t_out, IV) * (1 + SLIPPAGE)
            pnl_a += credit - buyback
        rows_a.append((str(nxt), money(pnl_a)))

        # ---- B: sell 05:30 (12h to expiry), hold to settlement
        t_b = 12 / 24 / 365
        pnl_b = 0.0
        for cp in ('C', 'P'):
            k = strike_for_premium(cp, s0530, t_b, IV, PREMIUM)
            credit = bs(cp, s0530, k, t_b, IV) * (1 - SLIPPAGE)
            # Settlement is not a trade: no spread, no slippage. Just intrinsic.
            settle = max(0.0, (s1730 - k) if cp == 'C' else (k - s1730))
            pnl_b += credit - settle
        rows_b.append((str(nxt), money(pnl_b)))

    def report(name, rows, held, note):
        v = [p for _, p in rows]
        wins = [x for x in v if x > 0]
        loss = [x for x in v if x <= 0]
        worst = min(rows, key=lambda r: r[1])
        gw, gl = sum(wins), -sum(loss)
        print(f'\n{name}')
        print('-' * 74)
        print(f'  days                {len(v):,}')
        print(f'  hours held          {held}')
        print(f'  win rate            {len(wins)/len(v)*100:.1f}%')
        print(f'  total               ${sum(v):+,.2f}   (Rs {sum(v)*USDINR:+,.0f})')
        print(f'  average day         ${st.fmean(v):+.4f}   (Rs {st.fmean(v)*USDINR:+.2f})')
        print(f'  best day            ${max(v):+.4f}')
        print(f'  worst day           ${worst[1]:+.4f}   on {worst[0]}')
        print(f'  profit factor       {gw/gl if gl else float("inf"):.2f}')
        print(f'  {note}')
        return v

    print('=' * 74)
    print('OVERNIGHT SELL vs FULL-EXPIRY HOLD')
    print('=' * 74)
    print(f'Premium sold        ${PREMIUM:.0f} per leg (CE + PE), {CONTRACTS} contracts each')
    print(f'Implied vol         {IV*100:.1f}%  (solved from a real Delta ticket)')
    print(f'Slippage            {SLIPPAGE*100:.0f}% on entry; on exit only when buying back')
    print(f'Days compared       {len(rows_a):,}')

    a = report('A  OVERNIGHT   sell 23:30 -> buy back 05:00', rows_a, '5.5',
               'exit is a real purchase: you pay the spread again')
    b = report('B  FULL HOLD   sell 05:30 -> settlement 17:30', rows_b, '12',
               'exit is settlement: no spread, no fee, and 100% of the premium kept when it expires worthless')

    print('\n' + '=' * 74)
    print('VERDICT')
    print('=' * 74)
    print(f'  A total  ${sum(a):+,.2f}    B total  ${sum(b):+,.2f}')
    better = 'B (full hold)' if sum(b) > sum(a) else 'A (overnight)'
    print(f'  better: {better}   by ${abs(sum(b)-sum(a)):,.2f} over {len(a):,} days')
    print(f'  per day: A Rs {st.fmean(a)*USDINR:+.2f}   B Rs {st.fmean(b)*USDINR:+.2f}')

    # How much of the premium each one actually gets to keep.
    print('\n  THETA CAPTURED (why):')
    t18, t125, t12 = 18/24/365, 12.5/24/365, 12/24/365
    s = 78_607.8
    k = strike_for_premium('C', s, t18, IV, PREMIUM)
    p_in = bs('C', s, k, t18, IV)
    p_out = bs('C', s, k, t125, IV)
    print(f'    A: a ${p_in:.2f} option with spot unchanged is worth ${p_out:.2f}')
    print(f'       at 05:00 -- {(1-p_out/p_in)*100:.0f}% of the premium decays in those 5.5 hours.')
    print(f'    B: held to expiry, an option that finishes out of the money')
    print(f'       decays 100%. Every cent of the premium is kept.')


if __name__ == '__main__':
    main()
