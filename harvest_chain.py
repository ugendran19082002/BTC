#!/usr/bin/env python3
"""Harvest the BTC daily-option chain at 05:30 IST plus the 12:00 UTC settlement.

Rows land in chain.db (SQLite). Resumable: a day already stored at the current
schema version is skipped. Public Delta India endpoints only -- no API key is
used or required.

  python3 harvest_chain.py <start YYYY-MM-DD> <end YYYY-MM-DD>
"""
import urllib.request, json, ssl, datetime, os, sys, time, random
import concurrent.futures as cf

import store

BASE = 'https://api.india.delta.exchange/v2'
CTX  = ssl.create_default_context()
VERSION = 2
STEP = 200
# Cheap out-of-the-money premium lives a long way from the money, so the window
# has to reach it: at 12h to expiry a $15 call can sit 4000-6000 above spot.
# Delta lists every 200 near the money and every 400 further out.
NEAR = 3000     # +/- this much at STEP
FAR = 6400      # then out to here at 2*STEP


def strike_offsets():
    out = list(range(-NEAR, NEAR + 1, STEP))
    for x in range(NEAR + 2 * STEP, FAR + 1, 2 * STEP):
        out.extend((-x, x))
    return sorted(out)


OFFSETS = strike_offsets()
# never sell more than two strikes into the money
CE_OFFSETS = [o for o in OFFSETS if o >= -2 * STEP]
PE_OFFSETS = [o for o in OFFSETS if o <= 2 * STEP]
# a mark outside this range is either untradeable dust or deep ITM, so skip the
# extra request for its traded prints
LTP_MIN, LTP_MAX = 0.3, 250.0


class Unavailable(Exception):
    """The request failed. Distinct from the endpoint answering with nothing --
    conflating the two writes empty days into the cache and silently poisons
    every backtest that reads them."""


def get(url, tries=6):
    last = 'unknown'
    for i in range(tries):
        try:
            r = urllib.request.Request(url, headers={'Accept': 'application/json',
                                                     'User-Agent': 'curl/8'})
            with urllib.request.urlopen(r, timeout=40, context=CTX) as f:
                return json.loads(f.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code not in (429, 500, 502, 503, 504):
                raise Unavailable(f'HTTP {e.code}')
            last = f'HTTP {e.code}'
        except Exception as e:
            last = repr(e)
        if i < tries - 1:
            time.sleep((2 ** i) * 0.6 + random.random())
    raise Unavailable(f'{last} after {tries} tries')


def candles(symbol, start, end):
    d = get(f'{BASE}/history/candles?resolution=1m&symbol={symbol}&start={start}&end={end}')
    return {c['time']: c for c in (d or {}).get('result') or []}


def spot_at(ts):
    """Last BTCUSD 1m close at or before ts."""
    for back in (600, 7200, 86400):
        c = candles('BTCUSD', ts - back, ts + 60)
        prior = [t for t in c if t <= ts]
        if prior:
            return c[max(prior)]['close']
    return None


def harvest_day(day):
    """day = the expiry date. Entry 00:00 UTC (05:30 IST), settle 12:00 UTC."""
    t_entry = int(datetime.datetime.combine(day, datetime.time(0, 0),
                                            datetime.timezone.utc).timestamp())
    t_settle = t_entry + 12 * 3600
    spot = spot_at(t_entry)
    settle = spot_at(t_settle)
    if spot is None or settle is None:
        return {'date': day.isoformat(), 'ok': False, 'why': 'no spot'}

    atm = int(round(spot / STEP) * STEP)
    ddmmyy = day.strftime('%d%m%y')
    jobs = ([('C', atm + o) for o in CE_OFFSETS] +
            [('P', atm + o) for o in PE_OFFSETS])

    def one(job):
        cp, k = job
        sym = f'{cp}-BTC-{k}-{ddmmyy}'
        # The mark series doubles as the existence check: a strike Delta never
        # listed returns zero bars rather than someone else's prices.
        mk = candles('MARK:' + sym, t_entry - 3600, t_entry + 60)
        if not mk:
            return None
        mark = (mk.get(t_entry) or {}).get('close')
        if mark is None:
            return None

        ltp = age = None
        vol = 0.0
        if LTP_MIN <= mark <= LTP_MAX:
            tr = candles(sym, t_entry - 8 * 3600, t_entry + 60)
            bar = tr.get(t_entry)
            ltp = bar['close'] if bar else None
            traded = [t for t, c in tr.items() if t <= t_entry and (c.get('volume') or 0) > 0]
            if traded:
                age = (t_entry - max(traded)) // 60
            vol = sum((c.get('volume') or 0) for c in tr.values())

        intrinsic = max(0.0, settle - k) if cp == 'C' else max(0.0, k - settle)
        return {
            'cp': cp, 'k': k, 'off': (k - atm) // STEP,
            'ltp': ltp,
            'mark': mark,
            'age_min': age,
            'vol_8h': vol,
            'settle_value': intrinsic,
        }

    legs = []
    with cf.ThreadPoolExecutor(4) as ex:
        for r in ex.map(one, jobs):
            if r:
                legs.append(r)
    # A real day has strikes on both sides of the money. Far fewer means the
    # feed was throttling us, not that the contracts were absent.
    if len(legs) < 20:
        raise Unavailable(f'only {len(legs)} legs came back')
    return {'date': day.isoformat(), 'ok': True, 'v': VERSION, 'spot': spot,
            'settle': settle, 'atm': atm, 'step': STEP, 'legs': legs}


def main():
    a = datetime.date.fromisoformat(sys.argv[1])
    b = datetime.date.fromisoformat(sys.argv[2])
    con = store.connect()
    d = a
    n = 0
    while d <= b:
        if not store.have_day(con, d.isoformat(), VERSION):
            try:
                rec = harvest_day(d)
            except Unavailable as e:
                # store nothing, so a later run retries this day
                print(f'{d}  SKIP {e}', flush=True)
                time.sleep(5)
                d += datetime.timedelta(days=1)
                continue
            store.save_day(con, rec)
            n += 1
            if n % 10 == 0:
                print(f'{d}  {n} days  legs={len(rec["legs"])}', flush=True)
        d += datetime.timedelta(days=1)
    con.close()
    print(f'done {a}..{b}  wrote {n}', flush=True)


if __name__ == '__main__':
    main()
