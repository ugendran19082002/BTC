#!/usr/bin/env python3
"""Two trades a day, or one? Three ways to work the same daily contract.

  S1  STACKED    23:30 sell $30, buy back at 50% decay
                 then 05:30 sell the $15 floor, buy back at 95% decay
                 -- two trades a day, the second starting after the first ends

  S2  OVERNIGHT  23:30 sell $30, buy back at 90% decay, else hold to the
                 17:30 settlement -- one trade, 18 hours

  S3  DAY ONLY   05:30 sell the $15 floor, buy back at 95% decay, else hold
                 -- one trade, 12 hours. The desk's actual rule.

All three are scored on the same days, so the totals are directly comparable.

MEASURED vs MODELLED, again
---------------------------------------------------------------------------
The 05:30 legs are real: chain.db records the entry mark, the settle value and
the intraday decay path of every leg the strategy sold. "Reached 95% decay at
minute 648" is read out of the table.

The 23:30 legs cannot be. There are no option quotes at that hour in any of
this data, so they are Black-Scholes on the real spot path at the vol the
market charges. Anything resting on S1 or S2 is an inference, not a
measurement, and the size of that caveat is the whole reason the two are
labelled on every line.

A note on margin: S1 reads as two trades in sequence, but they are not. The
overnight leg is still open at 05:30 on **41.7% of days** -- it either reached
its target after 05:00 or never reached it at all -- so on four days in ten S1
carries both positions at once and needs the margin for both. Anyone sizing S1
off the single-trade margin would be wrong nearly half the time.

  python3 research/combo_vs_single.py
"""
import datetime, json, math, os, sqlite3, statistics as st, zoneinfo

IST = zoneinfo.ZoneInfo('Asia/Kolkata')
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
CACHE = os.path.join(HERE, 'cache-5m.json')
MODEL_CACHE = os.path.join(HERE, 'cache-overnight.json')

CONTRACTS, CV, SLIP, USDINR, IV = 10, 0.001, 0.05, 85, 0.368


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


def real_day(frac):
    """05:30 entry, $15 floor, buy back once the mark falls to `frac` of entry."""
    con = sqlite3.connect(CHAIN)
    rows = con.execute("""
        SELECT p.date, p.cp, p.entry, p.decay, l.settle_value
        FROM paths p JOIN legs l ON l.date=p.date AND l.cp=p.cp AND l.k=p.k
        WHERE p.floor = 15.0 AND p.entry > 0
    """).fetchall()
    out, hit, n = {}, 0, 0
    for date, cp, entry, decay_json, settle in rows:
        n += 1
        d = json.loads(decay_json or '{}')
        credit = entry * (1 - SLIP)
        reached = d.get(str(frac))
        if reached is not None:
            hit += 1
            pnl = credit - entry * frac * (1 + SLIP)     # buying back costs the spread
        else:
            pnl = credit - (settle or 0.0)               # settlement costs nothing
        out[date] = out.get(date, 0.0) + money(pnl)
    return out, hit / n


def overnight(target_frac):
    """23:30 entry at $30, real spot path, buy back at the target else hold."""
    key = f'{target_frac}'
    cache = json.load(open(MODEL_CACHE)) if os.path.exists(MODEL_CACHE) else {}
    if key in cache:
        return {k: v for k, v in cache[key]['pnl'].items()}, cache[key]['hit'], cache[key]['overlap']

    bars = {int(t): b for t, b in json.load(open(CACHE)).items()}
    slot = {}
    for t, b in bars.items():
        dt = datetime.datetime.fromtimestamp(t, IST)
        slot[(dt.date(), dt.hour, dt.minute - dt.minute % 5)] = b['close']
    dates = sorted({d for d, _, _ in slot})

    pnl, hit, tot, overlap = {}, 0, 0, 0
    for i, d in enumerate(dates[:-1]):
        nxt = dates[i + 1]
        if (nxt - d).days != 1:
            continue
        s0 = slot.get((d, 23, 30))
        if s0 is None:
            continue
        day, ok, ran_long = 0.0, True, False
        for cp in ('C', 'P'):
            t_in = 18 / 24 / 365
            best, bd, base = None, 1e18, int(s0 / 200) * 200
            for j in range(120):
                k = base + j * 200 if cp == 'C' else base - j * 200
                if k <= 0:
                    break
                p = bs(cp, s0, k, t_in, IV)
                if abs(p - 30) < bd:
                    best, bd = k, abs(p - 30)
                if p < 6:
                    break
            k = best
            entry = bs(cp, s0, k, t_in, IV)
            credit, target = entry * (1 - SLIP), entry * target_frac
            tot += 1
            done = None
            for step in range(1, 217):
                mins = step * 5
                hh, mm = divmod((23 * 60 + 30 + mins) % 1440, 60)
                dd = d if (23 * 60 + 30 + mins) < 1440 else nxt
                s = slot.get((dd, hh, mm - mm % 5))
                if s is None:
                    continue
                val = bs(cp, s, k, max((18 * 60 - mins) / 60 / 24 / 365, 0), IV)
                if val <= target:
                    done = target * (1 + SLIP)
                    hit += 1
                    # did it still have the position when the day trade opened?
                    if mins > 330:
                        ran_long = True
                    break
            if done is None:
                s_end = slot.get((nxt, 17, 30))
                if s_end is None:
                    ok = False
                    break
                done = max(0.0, (s_end - k) if cp == 'C' else (k - s_end))
                ran_long = True
            day += money(credit - done)
        if ok:
            pnl[str(nxt)] = day
            overlap += 1 if ran_long else 0

    res = (pnl, hit / max(tot, 1), overlap / max(len(pnl), 1))
    cache[key] = {'pnl': pnl, 'hit': res[1], 'overlap': res[2]}
    json.dump(cache, open(MODEL_CACHE, 'w'))
    return res


def show(name, series, dates, note):
    v = [series[d] for d in dates]
    wins = [x for x in v if x > 0]
    loss = [x for x in v if x <= 0]
    gw, gl = sum(wins), -sum(loss)
    eq = peak = mdd = 0.0
    for x in v:
        eq += x
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)
    worst_d = min(dates, key=lambda d: series[d])
    print(f'\n{name}')
    print('-' * 78)
    print(f'  win rate          {len(wins)/len(v)*100:5.1f}%')
    print(f'  TOTAL             ${sum(v):+9.2f}    Rs {sum(v)*USDINR:+,.0f}')
    print(f'  average day       ${st.fmean(v):+9.4f}    Rs {st.fmean(v)*USDINR:+.2f}')
    print(f'  worst day         ${series[worst_d]:+9.4f}    Rs {series[worst_d]*USDINR:+,.0f}  on {worst_d}')
    print(f'  max drawdown      ${mdd:9.2f}    Rs {mdd*USDINR:,.0f}')
    print(f'  profit factor     {gw/gl if gl else float("inf"):9.2f}')
    print(f'  {note}')
    return sum(v), st.fmean(v), mdd


def main():
    day95, hit95 = real_day(0.05)
    on50, h50, ov50 = overnight(0.5)
    on90, h90, ov90 = overnight(0.1)

    dates = sorted(set(day95) & set(on50) & set(on90))
    print('=' * 78)
    print('STACKED vs OVERNIGHT vs DAY-ONLY')
    print('=' * 78)
    print(f'  common days       {len(dates):,}  ({dates[0]} to {dates[-1]})')
    print(f'  {CONTRACTS} contracts per leg, CE + PE, {SLIP*100:.0f}% slippage')
    print(f'  95% target reached on {hit95*100:.1f}% of real 05:30 legs')
    print(f'  50% target reached on {h50*100:.1f}% of modelled overnight legs')
    print(f'  overnight leg still open at 05:30 on {ov50*100:.1f}% of days (S1 margin overlap)')

    s1 = {d: on50[d] + day95[d] for d in dates}
    r = {}
    r['S1'] = show('S1  STACKED    23:30 $30 @50%  +  05:30 $15 @95%   [PART MODELLED]',
                   s1, dates, 'two trades a day; only the second is measured')
    r['S2'] = show('S2  OVERNIGHT  23:30 $30 @90%, else hold to 17:30   [MODELLED]',
                   on90, dates, 'no recorded quotes at 23:30 -- inference, not measurement')
    r['S3'] = show('S3  DAY ONLY   05:30 $15 @95%, else hold to 17:30   [REAL]',
                   day95, dates, "the desk's actual rule, measured end to end")

    print('\n' + '=' * 78)
    print('RANKING')
    print('=' * 78)
    for k, (t, a, m) in sorted(r.items(), key=lambda x: -x[1][0]):
        print(f'  {k}   ${t:+9.2f}   Rs {t*USDINR:+9,.0f}   per day Rs {a*USDINR:+7.2f}   maxDD Rs {m*USDINR:8,.0f}')

    print('\n  What the overnight leg contributes to S1:')
    onlyd = sum(day95[d] for d in dates)
    onlyn = sum(on50[d] for d in dates)
    print(f'    05:30 day trade alone   ${onlyd:+.2f}   Rs {onlyd*USDINR:+,.0f}')
    print(f'    23:30 overnight alone   ${onlyn:+.2f}   Rs {onlyn*USDINR:+,.0f}')
    print(f'    stacking them changes the total by Rs {onlyn*USDINR:+,.0f}')


if __name__ == '__main__':
    main()
