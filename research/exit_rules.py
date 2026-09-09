#!/usr/bin/env python3
"""Which exit rule, and which entry, actually made money?

Five ways to sell the same daily contract, over the same days:

  REAL (measured, from chain.db -- 733 days of settled chains and the intraday
  mark path of every leg the strategy actually sold)

    C-HOLD   05:30 entry, premium floor $15, hold to the 17:30 settlement
    C-50     the same, but buy back once the mark has fallen 50%
    C-90     the same, but buy back once the mark has fallen 90%

  MODELLED (there are NO recorded option quotes at 23:30 IST, so these cannot
  be measured the way the others can -- they are Black-Scholes on the real
  spot path, at the vol the market actually charges)

    A-50     23:30 entry at $30 premium, buy back at 50% decay, else hold
    A-90     23:30 entry at $30 premium, buy back at 90% decay, else hold

The model is not a guess: its strike selection was checked against 1,541 real
legs quoted between $25 and $35, which sit a median 2.20% out of the money --
the model puts them at 2.10%, at 38.2% implied vol against the model's 36.8%.
Close enough to trust the shape, not close enough to quote the totals to the
cent.

`decay` in the paths table is {fraction: first minute the mark reached it}, so
"0.1": 335 means the option was worth a tenth of its entry price 335 minutes
in -- a 90% decay, reached and bankable.

  python3 research/exit_rules.py
"""
import datetime, json, math, os, sqlite3, statistics as st, zoneinfo

IST = zoneinfo.ZoneInfo('Asia/Kolkata')
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
CACHE = os.path.join(HERE, 'cache-5m.json')

CONTRACTS = 10          # per leg
CV = 0.001              # BTC per contract
SLIP = 0.05
USDINR = 85
IV = 0.368


def money(q):
    """Quoted USD-per-BTC -> dollars in hand."""
    return q * CONTRACTS * CV


def cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(cp, s, k, t, v):
    if t <= 0 or v <= 0:
        return max(0.0, (s - k) if cp == 'C' else (k - s))
    d1 = (math.log(s / k) + 0.5 * v * v * t) / (v * math.sqrt(t))
    d2 = d1 - v * math.sqrt(t)
    return s * cdf(d1) - k * cdf(d2) if cp == 'C' else k * cdf(-d2) - s * cdf(-d1)


def summarise(name, pnls, note, exits=None):
    v = [p for _, p in pnls]
    wins = [x for x in v if x > 0]
    loss = [x for x in v if x <= 0]
    gw, gl = sum(wins), -sum(loss)
    worst = min(pnls, key=lambda r: r[1])
    eq, peak, mdd = 0.0, 0.0, 0.0
    for x in v:
        eq += x
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)
    print(f'\n{name}')
    print('-' * 78)
    print(f'  days              {len(v):,}')
    print(f'  win rate          {len(wins)/len(v)*100:5.1f}%')
    print(f'  TOTAL             ${sum(v):+9.2f}    Rs {sum(v)*USDINR:+,.0f}')
    print(f'  average day       ${st.fmean(v):+9.4f}    Rs {st.fmean(v)*USDINR:+.2f}')
    print(f'  worst day         ${worst[1]:+9.4f}    Rs {worst[1]*USDINR:+,.0f}   on {worst[0]}')
    print(f'  max drawdown      ${mdd:9.2f}    Rs {mdd*USDINR:,.0f}')
    print(f'  profit factor     {gw/gl if gl else float("inf"):9.2f}')
    if exits is not None:
        print(f'  target hit        {exits*100:5.1f}% of legs')
    print(f'  {note}')
    return sum(v), st.fmean(v)


def real_rules():
    con = sqlite3.connect(CHAIN)
    rows = con.execute("""
        SELECT p.date, p.cp, p.k, p.entry, p.decay, l.settle_value
        FROM paths p JOIN legs l ON l.date = p.date AND l.cp = p.cp AND l.k = p.k
        WHERE p.floor = 15.0 AND p.entry > 0
    """).fetchall()

    out = {'hold': {}, '50': {}, '90': {}}
    hits = {'50': 0, '90': 0}
    n = 0
    for date, cp, k, entry, decay_json, settle in rows:
        n += 1
        d = json.loads(decay_json or '{}')
        credit = entry * (1 - SLIP)
        # Settlement is not a trade: no spread to pay, just what it is worth.
        out['hold'][date] = out['hold'].get(date, 0.0) + money(credit - (settle or 0.0))
        for frac, key in ((0.5, '50'), (0.1, '90')):
            reached = d.get(str(frac))
            if reached is not None:
                hits[key] += 1
                # Buying back is a real purchase: pay the spread.
                pnl = credit - entry * frac * (1 + SLIP)
            else:
                pnl = credit - (settle or 0.0)
            out[key][date] = out[key].get(date, 0.0) + money(pnl)
    return out, {k: v / n for k, v in hits.items()}, n


def modelled_overnight(target_frac):
    """23:30 entry at $30, walk the real spot path, buy back at the target."""
    bars = {int(t): b for t, b in json.load(open(CACHE)).items()}
    slot = {}
    for t, b in bars.items():
        dt = datetime.datetime.fromtimestamp(t, IST)
        slot[(dt.date(), dt.hour, dt.minute - dt.minute % 5)] = b['close']
    dates = sorted({d for d, _, _ in slot})

    pnls = {}
    hit = tot = 0
    for i, d in enumerate(dates[:-1]):
        nxt = dates[i + 1]
        if (nxt - d).days != 1:
            continue
        s0 = slot.get((d, 23, 30))
        if not s0:
            continue
        day = 0.0
        ok = True
        for cp in ('C', 'P'):
            # strike on Delta's 200-point grid nearest a $30 premium at 18h
            t_in = 18 / 24 / 365
            best, bd = None, 1e18
            base = int(s0 / 200) * 200
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
            credit = entry * (1 - SLIP)
            target = entry * target_frac
            tot += 1
            done = None
            # walk 23:30 -> 17:30 next day in five-minute steps
            for step in range(1, 217):
                mins = step * 5
                hh, mm = divmod((23 * 60 + 30 + mins) % 1440, 60)
                dd = d if (23 * 60 + 30 + mins) < 1440 else nxt
                s = slot.get((dd, hh, mm - mm % 5))
                if s is None:
                    continue
                t_left = (18 * 60 - mins) / 60 / 24 / 365
                val = bs(cp, s, k, max(t_left, 0), IV)
                if val <= target:
                    done = target * (1 + SLIP)
                    hit += 1
                    break
            if done is None:
                s_end = slot.get((nxt, 17, 30))
                if s_end is None:
                    ok = False
                    break
                done = max(0.0, (s_end - k) if cp == 'C' else (k - s_end))
            day += money(credit - done)
        if ok:
            pnls[str(nxt)] = day
    return pnls, hit / max(tot, 1)


def main():
    print('=' * 78)
    print('EXIT RULES AND ENTRY TIMES, COMPARED')
    print('=' * 78)
    print(f'{CONTRACTS} contracts per leg (CE + PE), {SLIP*100:.0f}% slippage,')
    print('settlement costs nothing extra; buying back pays the spread.')

    real, hits, n = real_rules()
    print(f'\nREAL DATA -- {n:,} legs over {len(real["hold"]):,} days, from chain.db')

    tot = {}
    tot['C-HOLD'] = summarise(
        'C-HOLD   05:30 entry, premium floor $15, hold to settlement  [REAL]',
        sorted(real['hold'].items()), 'the desk\'s actual baseline rule')
    tot['C-50'] = summarise(
        'C-50     05:30 entry, floor $15, buy back at 50% decay        [REAL]',
        sorted(real['50'].items()), 'takes half the premium and stands aside', hits['50'])
    tot['C-90'] = summarise(
        'C-90     05:30 entry, floor $15, buy back at 90% decay        [REAL]',
        sorted(real['90'].items()), 'holds for nearly all of it, then closes', hits['90'])

    for frac, key, label in ((0.5, 'A-50', '50%'), (0.1, 'A-90', '90%')):
        p, h = modelled_overnight(frac)
        tot[key] = summarise(
            f'{key}     23:30 entry, $30 premium, buy back at {label} decay   [MODELLED]',
            sorted(p.items()), 'no recorded quotes at 23:30 -- Black-Scholes on the real spot path', h)

    print('\n' + '=' * 78)
    print('RANKING  (by total, over the same days)')
    print('=' * 78)
    for name, (t, avg) in sorted(tot.items(), key=lambda x: -x[1][0]):
        tag = 'REAL    ' if name.startswith('C') else 'MODELLED'
        print(f'  {name:<8} {tag}  ${t:+9.2f}   Rs {t*USDINR:+9,.0f}   per day Rs {avg*USDINR:+7.2f}')


if __name__ == '__main__':
    main()
