#!/usr/bin/env python3
"""How often does an option actually expire worthless, against what the model says?

Black-Scholes gives a probability. Two years of settlements give a frequency.
They are not the same number, and the gap is the honest part: crypto's tails are
fatter than the lognormal the model assumes, so a strike the model calls 95%
safe is not 95% safe.

Writes a calibration table into chain.db that the desk reads at request time.

  python3 calibrate.py
"""
import math, json, datetime
import store

SETTLE_HOURS = 12.0
T = SETTLE_HOURS / (365 * 24)
SQRT_2PI = math.sqrt(2 * math.pi)


def cdf(x):
    s = -1 if x < 0 else 1
    z = abs(x) / math.sqrt(2)
    t = 1 / (1 + 0.3275911 * z)
    y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
              - 0.284496736) * t + 0.254829592) * t * math.exp(-z * z)
    return 0.5 * (1 + s * y)


def bs_price(cp, s, k, t, v):
    if t <= 0 or v <= 0:
        return max(0.0, s - k) if cp == 'C' else max(0.0, k - s)
    sq = v * math.sqrt(t)
    d1 = (math.log(s / k) + 0.5 * v * v * t) / sq
    d2 = d1 - sq
    return s * cdf(d1) - k * cdf(d2) if cp == 'C' else k * cdf(-d2) - s * cdf(-d1)


def implied_vol(cp, price, s, k, t):
    intrinsic = max(0.0, s - k) if cp == 'C' else max(0.0, k - s)
    if price <= intrinsic or t <= 0:
        return None
    lo, hi = 0.01, 5.0
    if bs_price(cp, s, k, t, hi) < price:
        return None
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if bs_price(cp, s, k, t, mid) < price:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def delta(cp, s, k, t, v):
    sq = v * math.sqrt(t)
    d1 = (math.log(s / k) + 0.5 * v * v * t) / sq
    return cdf(d1) if cp == 'C' else cdf(d1) - 1


SCHEMA = """
CREATE TABLE IF NOT EXISTS calibration (
    kind       TEXT NOT NULL,      -- 'model_potm' or 'em_distance'
    bucket_lo  REAL NOT NULL,
    bucket_hi  REAL NOT NULL,
    legs       INTEGER NOT NULL,
    expired_0  INTEGER NOT NULL,
    rate       REAL NOT NULL,      -- share that expired worthless
    avg_mark   REAL NOT NULL,
    PRIMARY KEY (kind, bucket_lo)
);
"""


def main():
    con = store.connect()
    con.executescript(SCHEMA)

    days = {}
    for d in con.execute('SELECT * FROM days'):
        days[d['date']] = dict(d)
    rows = con.execute('SELECT * FROM legs').fetchall()

    model_buckets = {}
    em_buckets = {}
    n = skipped = 0

    for l in rows:
        d = days.get(l['date'])
        if not d or l['mark'] is None or l['mark'] <= 0:
            continue
        cp, k, s = l['cp'], l['k'], d['spot']
        # Every strike, not just the ones you would sell. An in-the-money strike
        # that still expired worthless is rare and worth counting, and leaving
        # them out left the table with nothing to say about half the chain.
        v = implied_vol(cp, l['mark'], s, k, T)
        if v is None:
            skipped += 1
            continue
        p_otm = 1 - abs(delta(cp, s, k, T, v))
        worthless = 1 if l['settle_value'] == 0 else 0
        n += 1

        b = max(0.0, min(int(p_otm * 20) / 20, 0.95))   # 5-point buckets, 0..95
        e = model_buckets.setdefault(b, [0, 0, 0.0])
        e[0] += 1; e[1] += worthless; e[2] += l['mark']

    # distance measured in the market's own expected move for that day
    for date, d in days.items():
        atm = [r for r in rows if r['date'] == date and r['k'] == d['atm']]
        marks = {r['cp']: r['mark'] for r in atm if r['mark']}
        if 'C' not in marks or 'P' not in marks:
            continue
        em = (marks['C'] + marks['P']) * 0.8
        if em <= 0:
            continue
        for l in (r for r in rows if r['date'] == date):
            if l['mark'] is None or l['mark'] <= 0:
                continue
            # signed distance: negative is in the money, and it belongs in the
            # table too
            otm = (l['cp'] == 'C' and l['k'] > d['atm']) or (l['cp'] == 'P' and l['k'] < d['atm'])
            r_ = (1 if otm else -1) * abs(l['k'] - d['spot']) / em
            b = max(-3.0, min(round(r_ * 2) / 2, 5.0))
            e = em_buckets.setdefault(b, [0, 0, 0.0])
            e[0] += 1; e[1] += (l['settle_value'] == 0); e[2] += l['mark']

    with con:
        con.execute('DELETE FROM calibration')
        for kind, buckets, step in (('model_potm', model_buckets, 0.05),
                                    ('em_distance', em_buckets, 0.5)):
            for b, (legs, z, msum) in sorted(buckets.items()):
                if legs < 30:
                    continue
                con.execute(
                    'INSERT INTO calibration (kind, bucket_lo, bucket_hi, legs,'
                    ' expired_0, rate, avg_mark) VALUES (?,?,?,?,?,?,?)',
                    (kind, b, b + step, legs, z, z / legs, msum / legs),
                )

    print(f'{n} legs calibrated, {skipped} unpriceable\n')
    print('  MODEL SAYS  ->  ACTUALLY EXPIRED WORTHLESS')
    for r in con.execute("SELECT * FROM calibration WHERE kind='model_potm' ORDER BY bucket_lo"):
        gap = 100 * (r['rate'] - (r['bucket_lo'] + 0.025))
        print(f"   {r['bucket_lo']*100:>5.0f}-{r['bucket_hi']*100:<3.0f}%  "
              f"{r['legs']:>6} legs   {r['rate']*100:>6.2f}%   "
              f"{'model too optimistic by' if gap<0 else 'model too cautious by '} {abs(gap):>5.2f}pt")
    print('\n  DISTANCE IN EXPECTED MOVES  ->  EXPIRED WORTHLESS')
    for r in con.execute("SELECT * FROM calibration WHERE kind='em_distance' ORDER BY bucket_lo"):
        print(f"   {r['bucket_lo']:>4.1f}x  {r['legs']:>6} legs   {r['rate']*100:>6.2f}%   "
              f"avg premium ${r['avg_mark']:>7.2f}")


if __name__ == '__main__':
    main()
