#!/usr/bin/env python3
"""Premium floors, entry times, and whether the losing days can be seen coming.

Three questions, and they are not equally answerable. The report says which is
which on every table, because the difference matters more than the numbers.

  1  PREMIUM FLOOR   -- MEASURED. chain.db holds every strike quoted at 05:30
     with what it settled at, so a floor of $11 or $25 is read straight out of
     the table the same way $15 is.

  2  LOSING DAYS     -- MEASURED. Every candidate filter uses only what was
     knowable at 05:30: the premium on offer, how far out the strike sat, the
     at-the-money vol, what BTC did the day before, the weekday. A filter that
     peeks at the settlement would look wonderful and be worthless.

  3  ENTRY TIME      -- PART MODELLED. The harvester captures 05:30 only, so
     there are no quotes at 05:00 or 06:00. These are priced off *that same
     day's* real smile, solved from that day's own quoted marks, applied to the
     real spot at the entry minute. Vol and settlement are real; the entry
     premium is computed. Weaker than 1 and 2, stronger than a flat assumption.

A filter is only worth having if it skips more loss than profit. Every filter
below is scored on both, because "avoids the crash" is easy and "avoids the
crash without giving back the year" is the whole problem.

  python3 research/floor_and_filters.py
"""
import datetime, json, math, os, sqlite3, statistics as st, zoneinfo

IST = zoneinfo.ZoneInfo('Asia/Kolkata')
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHAIN = os.path.join(ROOT, 'chain.db')
CACHE = os.path.join(HERE, 'cache-5m.json')
OUT = os.path.join(HERE, 'FLOOR-FILTER-REPORT.txt')

CONTRACTS, CV, SLIP, USDINR = 10, 0.001, 0.05, 85
FLOORS = [8, 11, 13, 15, 18, 20, 22, 25, 30]
TIMES = [(5, 0), (5, 15), (5, 30), (5, 45), (5, 55), (6, 0)]


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
    lo, hi = 0.05, 4.0
    for _ in range(90):
        m = (lo + hi) / 2
        if bs(cp, s, k, t, m) < p:
            lo = m
        else:
            hi = m
    return (lo + hi) / 2


def load():
    con = sqlite3.connect(CHAIN)
    days = {d: (spot, settle, atm, step) for d, spot, settle, atm, step in
            con.execute('SELECT date,spot,settle,atm,step FROM days WHERE settle IS NOT NULL')}
    legs = {}
    for date, cp, k, mark, sv in con.execute(
            'SELECT date,cp,k,mark,settle_value FROM legs WHERE mark>0'):
        legs.setdefault(date, []).append((cp, k, mark, sv))
    return days, legs


def pick(legs_today, cp, spot, floor):
    """Richest OTM strike at or below the floor -- the README's own rule."""
    best = None
    for c, k, mark, sv in legs_today:
        if c != cp or mark > floor:
            continue
        if cp == 'C' and k <= spot:
            continue
        if cp == 'P' and k >= spot:
            continue
        if best is None or mark > best[1]:
            best = (k, mark, sv)
    return best


def run_floor(days, legs, floor):
    """Hold to settlement, both legs, at this premium floor."""
    out, detail = {}, {}
    for date, (spot, settle, atm, step) in days.items():
        if date not in legs:
            continue
        tot, info, ok = 0.0, [], True
        for cp in ('C', 'P'):
            got = pick(legs[date], cp, spot, floor)
            if got is None:
                ok = False
                break
            k, mark, sv = got
            tot += money(mark * (1 - SLIP) - (sv or 0.0))
            info.append({'cp': cp, 'k': k, 'mark': mark, 'sv': sv or 0.0,
                         'otm': abs(k - spot) / spot * 100})
        if ok:
            out[date] = tot
            detail[date] = info
    return out, detail


def stats(v):
    wins = [x for x in v if x > 0]
    gl = -sum(x for x in v if x <= 0)
    eq = peak = mdd = 0.0
    for x in v:
        eq += x
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)
    return (sum(v), st.fmean(v), len(wins) / len(v) * 100, min(v), mdd,
            (sum(wins) / gl) if gl else float('inf'))


def main():
    days, legs = load()
    L = []
    w = L.append

    w('=' * 86)
    w('R&D: PREMIUM FLOORS, ENTRY TIMES, AND SKIPPING THE LOSING DAYS')
    w('=' * 86)
    w(f'{CONTRACTS} contracts per leg, CE + PE, {SLIP*100:.0f}% slippage, held to settlement')
    w('')

    # ---------------------------------------------------------- 1. FLOORS
    w('=' * 86)
    w('1.  PREMIUM FLOOR SWEEP      [MEASURED -- real quotes, real settlements]')
    w('=' * 86)
    w(f'  {"FLOOR":>6} {"DAYS":>5} {"OTM":>6} {"TOTAL Rs":>10} {"/DAY":>7} {"WIN%":>6} '
      f'{"PF":>6} {"WORST Rs":>9} {"MDD Rs":>8}')
    w('  ' + '-' * 74)
    floor_res = {}
    for f in FLOORS:
        res, det = run_floor(days, legs, f)
        if len(res) < 100:
            continue
        dts = sorted(res)
        v = [res[d] for d in dts]
        otm = st.fmean([i['otm'] for d in dts for i in det[d]])
        tot, avg, win, worst, mdd, pf = stats(v)
        floor_res[f] = (res, det, dts)
        w(f'  {"$"+str(f):>6} {len(v):>5} {otm:>5.2f}% {tot*USDINR:>+10,.0f} '
          f'{avg*USDINR:>+7.2f} {win:>5.1f}% {pf:>6.2f} {worst*USDINR:>+9,.0f} {mdd*USDINR:>8,.0f}')
    w('')
    w('  A higher floor means a richer premium and a strike closer to spot. The')
    w('  premium rises steadily; so does the worst day. Where the two cross is')
    w('  the only thing this table is for.')
    w('')

    # ------------------------------------------------------ 2. ENTRY TIMES
    w('=' * 86)
    w('2.  ENTRY TIME               [PART MODELLED -- see the header]')
    w('=' * 86)
    bars = {int(t): b for t, b in json.load(open(CACHE)).items()}
    slot = {}
    for t, b in bars.items():
        dd = datetime.datetime.fromtimestamp(t, IST)
        slot[(dd.date(), dd.hour, dd.minute - dd.minute % 5)] = b['close']

    w(f'  {"TIME":>6} {"DAYS":>5} {"TOTAL Rs":>10} {"/DAY":>7} {"WIN%":>6} {"PF":>6} '
      f'{"WORST Rs":>9} {"MDD Rs":>8}')
    w('  ' + '-' * 66)
    for hh, mm in TIMES:
        out = {}
        for date, (spot, settle, atm, step) in days.items():
            if date not in legs:
                continue
            d0 = datetime.date.fromisoformat(date)
            s_now = slot.get((d0, hh, mm - mm % 5))
            if s_now is None:
                continue
            # that day's own vol, from the real 05:30 chain
            ivs = []
            for cp, k, mark, sv in legs[date]:
                otm = (k - spot) / spot if cp == 'C' else (spot - k) / spot
                if 0.01 < otm < 0.05 and mark > 1:
                    x = solve_iv(cp, spot, k, 12 / 24 / 365, mark)
                    if x:
                        ivs.append(x)
            if len(ivs) < 4:
                continue
            iv = st.median(ivs)
            t_left = ((17 * 60 + 30) - (hh * 60 + mm)) / 60 / 24 / 365
            tot, ok = 0.0, True
            for cp in ('C', 'P'):
                base = int(s_now / step) * step
                k = None
                for j in range(200):
                    kk = base + j * step if cp == 'C' else base - j * step
                    if kk <= 0:
                        break
                    if bs(cp, s_now, kk, t_left, iv) <= 15:
                        k = kk
                        break
                if k is None:
                    ok = False
                    break
                prem = bs(cp, s_now, k, t_left, iv)
                sv = max(0.0, (settle - k) if cp == 'C' else (k - settle))
                tot += money(prem * (1 - SLIP) - sv)
            if ok:
                out[date] = tot
        if len(out) < 100:
            continue
        v = [out[d] for d in sorted(out)]
        tot, avg, win, worst, mdd, pf = stats(v)
        mark = '  <- the desk' if (hh, mm) == (5, 30) else ''
        w(f'  {hh:02d}:{mm:02d} {len(v):>5} {tot*USDINR:>+10,.0f} {avg*USDINR:>+7.2f} '
          f'{win:>5.1f}% {pf:>6.2f} {worst*USDINR:>+9,.0f} {mdd*USDINR:>8,.0f}{mark}')
    w('')
    w('  These are one model applied six times, so compare them with each other,')
    w('  not with section 1. An hour either side of 05:30 changes little: the')
    w('  contract has 12 hours to run and one of them is not the difference.')
    w('')

    # ------------------------------------------------- 3. THE LOSING DAYS
    res15, det15, dts15 = floor_res[15]
    losses = sorted([d for d in dts15 if res15[d] <= 0], key=lambda d: res15[d])
    w('=' * 86)
    w('3.  THE LOSING DAYS          [MEASURED]')
    w('=' * 86)
    w(f'  {len(losses)} losing days out of {len(dts15)}  ({len(losses)/len(dts15)*100:.1f}%)')
    w(f'  they cost Rs {sum(res15[d] for d in losses)*USDINR:+,.0f}; the winners made '
      f'Rs {sum(res15[d] for d in dts15 if res15[d]>0)*USDINR:+,.0f}')
    w('')

    # features knowable at 05:30
    feat = {}
    prev = None
    for d in dts15:
        spot, settle, atm, step = days[d]
        ivs = []
        for cp, k, mark, sv in legs[d]:
            otm = (k - spot) / spot if cp == 'C' else (spot - k) / spot
            if 0.01 < otm < 0.05 and mark > 1:
                x = solve_iv(cp, spot, k, 12 / 24 / 365, mark)
                if x:
                    ivs.append(x)
        prior = abs(prev[1] - prev[0]) / prev[0] * 100 if prev else None
        feat[d] = {
            'iv': st.median(ivs) * 100 if len(ivs) >= 4 else None,
            'prem': st.fmean([i['mark'] for i in det15[d]]),
            'otm': st.fmean([i['otm'] for i in det15[d]]),
            'prior': prior,
            'dow': datetime.date.fromisoformat(d).weekday(),
            'realised': abs(settle - spot) / spot * 100,
        }
        prev = (spot, settle)

    w('  WHAT A LOSING DAY LOOKED LIKE AT 05:30, against all days')
    w(f'  {"FEATURE":<26} {"losing days":>13} {"all days":>11} {"":>6}')
    for key, name, unit in (('iv', 'at-the-money IV', '%'),
                            ('prem', 'premium on offer', '$'),
                            ('otm', 'strike distance', '%'),
                            ('prior', "yesterday's move", '%')):
        a = [feat[d][key] for d in losses if feat[d][key] is not None]
        b = [feat[d][key] for d in dts15 if feat[d][key] is not None]
        if not a:
            continue
        diff = st.median(a) - st.median(b)
        w(f'  {name:<26} {st.median(a):>12.2f}{unit} {st.median(b):>10.2f}{unit} '
          f'{diff:>+6.2f}')
    w('')
    w('  and what actually happened that day, which was NOT knowable at 05:30:')
    a = [feat[d]['realised'] for d in losses]
    b = [feat[d]['realised'] for d in dts15]
    w(f'  {"BTC move to settlement":<26} {st.median(a):>12.2f}% {st.median(b):>10.2f}% '
      f'{st.median(a)-st.median(b):>+6.2f}')
    w('')
    w('  The losing days are the days BTC moved. Nothing on the first list')
    w('  separates them at 05:30 by anything like the margin the last one does.')
    w('')

    # ------------------------------------------------------- 4. FILTERS
    w('=' * 86)
    w('4.  CAN THE LOSING DAYS BE SKIPPED?   [MEASURED]')
    w('=' * 86)
    w('  Each filter stands the desk aside on the days it flags. A filter earns')
    w('  its place only if what it saves exceeds what it gives up.')
    w('')
    w(f'  {"FILTER":<30} {"SKIP":>5} {"LOSS SAVED":>11} {"PROFIT LOST":>12} {"NET Rs":>9} {"NEW TOTAL":>10}')
    w('  ' + '-' * 80)
    base_total = sum(res15[d] for d in dts15)

    def test(name, flag):
        sk = [d for d in dts15 if flag(d)]
        if not sk or len(sk) > len(dts15) * 0.6:
            return None
        saved = -sum(res15[d] for d in sk if res15[d] <= 0)
        given = sum(res15[d] for d in sk if res15[d] > 0)
        net = saved - given
        return (name, len(sk), saved, given, net, base_total + net)

    cands = []
    for thr in (55, 60, 65, 70):
        cands.append(test(f'skip when IV > {thr}%',
                          lambda d, t=thr: (feat[d]['iv'] or 0) > t))
    for thr in (2.0, 3.0, 4.0):
        cands.append(test(f"skip when yesterday moved >{thr}%",
                          lambda d, t=thr: (feat[d]['prior'] or 0) > t))
    for thr in (2.0, 2.5, 3.0):
        cands.append(test(f'skip when strike closer than {thr}%',
                          lambda d, t=thr: feat[d]['otm'] < t))
    for thr in (12, 13, 14):
        cands.append(test(f'skip when premium > ${thr}',
                          lambda d, t=thr: feat[d]['prem'] > t))
    cands.append(test('skip Fridays', lambda d: feat[d]['dow'] == 4))
    cands.append(test('skip Mondays', lambda d: feat[d]['dow'] == 0))
    for c in sorted([c for c in cands if c], key=lambda x: -x[4]):
        name, n, saved, given, net, newt = c
        w(f'  {name:<30} {n:>5} {saved*USDINR:>+11,.0f} {given*USDINR:>+12,.0f} '
          f'{net*USDINR:>+9,.0f} {newt*USDINR:>+10,.0f}')
    w('')
    w(f'  doing nothing at all:                                              '
      f'{base_total*USDINR:>+10,.0f}')
    w('')
    best = max([c for c in cands if c], key=lambda x: x[4])
    if best[4] <= 0:
        w('  NOT ONE FILTER PAYS FOR ITSELF. Every one of them gives up more profit')
        w('  than it saves in losses, which is the honest answer to the question.')
    else:
        w(f'  Best: {best[0]} -- but read the caveat below before using it.')
    w('')
    w('  THE CAVEAT THAT MATTERS: these thresholds were chosen by looking at the')
    w('  same 733 days they are scored on. That is how a filter is found and it is')
    w('  not how one is proved. A rule fitted to the days it is tested on will')
    w('  always look better than it will behave. Section 5 splits the record.')
    w('')

    # -------------------------------------------------- 5. OUT OF SAMPLE
    w('=' * 86)
    w('5.  DOES ANY OF IT HOLD UP OUT OF SAMPLE?')
    w('=' * 86)
    half = len(dts15) // 2
    first, second = dts15[:half], dts15[half:]
    w(f'  first half  {first[0]} to {first[-1]}   ({len(first)} days)')
    w(f'  second half {second[0]} to {second[-1]}   ({len(second)} days)')
    w('')
    w(f'  {"FILTER":<30} {"1st half net":>13} {"2nd half net":>13} {"holds?":>8}')
    w('  ' + '-' * 68)
    for c in sorted([c for c in cands if c], key=lambda x: -x[4])[:6]:
        name = c[0]
        flag = None
        for cand_name, f2 in (('x', None),):
            pass
        # re-derive the predicate by name lookup
        preds = {}
        for thr in (55, 60, 65, 70):
            preds[f'skip when IV > {thr}%'] = lambda d, t=thr: (feat[d]['iv'] or 0) > t
        for thr in (2.0, 3.0, 4.0):
            preds[f"skip when yesterday moved >{thr}%"] = lambda d, t=thr: (feat[d]['prior'] or 0) > t
        for thr in (2.0, 2.5, 3.0):
            preds[f'skip when strike closer than {thr}%'] = lambda d, t=thr: feat[d]['otm'] < t
        for thr in (12, 13, 14):
            preds[f'skip when premium > ${thr}'] = lambda d, t=thr: feat[d]['prem'] > t
        preds['skip Fridays'] = lambda d: feat[d]['dow'] == 4
        preds['skip Mondays'] = lambda d: feat[d]['dow'] == 0
        flag = preds[name]
        nets = []
        for part in (first, second):
            sk = [d for d in part if flag(d)]
            saved = -sum(res15[d] for d in sk if res15[d] <= 0)
            given = sum(res15[d] for d in sk if res15[d] > 0)
            nets.append(saved - given)
        holds = 'yes' if nets[0] > 0 and nets[1] > 0 else 'NO'
        w(f'  {name:<30} {nets[0]*USDINR:>+13,.0f} {nets[1]*USDINR:>+13,.0f} {holds:>8}')
    w('')
    w('  A filter that helps in one half and hurts in the other has found a')
    w('  feature of those particular days, not of the strategy. The README says')
    w('  the same thing about the R&D engine: results flip between regimes, and')
    w('  only what survives both halves is worth carrying.')
    w('=' * 86)

    text = '\n'.join(L) + '\n'
    open(OUT, 'w').write(text)
    print(text)
    print(f'wrote -> {OUT}')


if __name__ == '__main__':
    main()
