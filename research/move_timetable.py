#!/usr/bin/env python3
"""When does BTC actually move? A timetable, in IST, over the whole record.

The question this answers is "what time of what day is dangerous", which is a
different question from `study_horizons.py`'s "how far does it move over N
minutes". That one pools every window together and so cannot tell you that
18:30 IST is not 04:00 IST. This one keeps them apart.

Every five-minute bar Delta India has for BTCUSD is bucketed by
(weekday, time of day) in **IST**, because the strategy is defined in IST --
entry 05:30, exit 17:29 -- and a table in UTC would put the two moments this
desk cares about in the wrong rows.

Two different measures, kept apart on purpose:

  move   |close - open| / open   what the bar did, end to end. This is what a
                                 settled option is priced against.
  range  (high - low)  / open    how far it travelled inside the bar. This is
                                 what reaches a stop, and it is always larger.

A bar that opens and closes at the same price after a 1% round trip has a move
of zero and a range of 1%. Reading only the first is how a stop gets placed
inside the noise.

  python3 research/move_timetable.py [--days N] [--out FILE]

Raw bars are cached in research/cache-5m.json, so a re-run costs nothing.
"""
import argparse, datetime, json, os, statistics as st, sys, time, zoneinfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from study_horizons import _fetch  # noqa: E402  the same public endpoint

IST = zoneinfo.ZoneInfo('Asia/Kolkata')
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache-5m.json')
BAR = 300
DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

# Delta India's BTCUSD perpetual starts here; asking for earlier returns nothing.
FIRST = datetime.datetime(2023, 12, 29, tzinfo=datetime.timezone.utc)


def fetch_all(start_ts, end_ts, cache=CACHE):
    """Page backwards through the candle endpoint, caching as we go.

    The endpoint caps a response at ~2000 bars, so the whole record needs about
    160 calls. Cached because that is several minutes and the answer does not
    change for bars that have already settled.
    """
    bars = {}
    if os.path.exists(cache):
        with open(cache) as f:
            bars = {int(k): v for k, v in json.load(f).items()}
        print(f'  {len(bars):,} bars from cache', file=sys.stderr)

    cursor = end_ts
    calls = 0
    while cursor > start_ts:
        lo = max(start_ts, cursor - 1800 * BAR)
        # Everything in this span already cached? Skip the call.
        want = set(range(lo - lo % BAR, cursor, BAR))
        if want and len(want - bars.keys()) < len(want) * 0.02:
            cursor = lo - BAR
            continue
        for attempt in range(4):
            try:
                chunk = _fetch('5m', lo, cursor)
                break
            except Exception as e:                      # noqa: BLE001
                if attempt == 3:
                    raise
                print(f'    retry after {e}', file=sys.stderr)
                time.sleep(2 * (attempt + 1))
        calls += 1
        if not chunk:
            break
        before = len(bars)
        for c in chunk:
            bars[c['time']] = c
        if len(bars) == before:
            break
        cursor = min(c['time'] for c in chunk) - BAR
        if calls % 20 == 0:
            print(f'  {calls} calls, {len(bars):,} bars', file=sys.stderr)

    with open(cache, 'w') as f:
        json.dump({str(k): v for k, v in bars.items()}, f)
    return [bars[t] for t in sorted(bars)]


def pct(xs, p):
    """Percentile by nearest rank. Small buckets make interpolation a lie."""
    if not xs:
        return 0.0
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, int(round(p / 100 * len(s))) - 1))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=0, help='0 = the whole record')
    ap.add_argument('--out', default=os.path.join(HERE, 'MOVE-TIMETABLE.txt'))
    ap.add_argument('--csv', default='', help='also write every bar to this CSV')
    a = ap.parse_args()

    now = datetime.datetime.now(datetime.timezone.utc)
    start = FIRST if a.days == 0 else now - datetime.timedelta(days=a.days)
    print(f'fetching 5m bars {start.date()} -> {now.date()}', file=sys.stderr)
    bars = fetch_all(int(start.timestamp()), int(now.timestamp()))
    if len(bars) < 5000:
        raise SystemExit(f'only {len(bars)} bars; refusing to report on that')

    # (weekday, minute-of-day) -> lists
    moves, ranges, ups = {}, {}, {}
    per_date, dates = {}, set()
    rows_csv = []

    for b in bars:
        o, h, l, c = b['open'], b['high'], b['low'], b['close']
        if not o:
            continue
        t = datetime.datetime.fromtimestamp(b['time'], IST)
        key = (t.weekday(), t.hour * 60 + t.minute - (t.minute % 5))
        mv = abs(c - o) / o * 100
        rg = (h - l) / o * 100
        moves.setdefault(key, []).append(mv)
        ranges.setdefault(key, []).append(rg)
        ups.setdefault(key, []).append(1 if c > o else 0)
        d = t.date().isoformat()
        dates.add(d)
        pd = per_date.setdefault(d, {'mv': [], 'rg': [], 'wd': t.weekday()})
        pd['mv'].append(mv)
        pd['rg'].append(rg)
        if a.csv:
            rows_csv.append(
                f'{d},{t.strftime("%H:%M")},{DAYS[t.weekday()]},{o},{h},{l},{c},'
                f'{mv:.4f},{rg:.4f}'
            )

    if a.csv:
        with open(a.csv, 'w') as f:
            f.write('date_ist,time_ist,weekday,open,high,low,close,move_pct,range_pct\n')
            f.write('\n'.join(rows_csv) + '\n')
        print(f'wrote {len(rows_csv):,} bars -> {a.csv}', file=sys.stderr)

    first_d, last_d = min(dates), max(dates)
    out = []
    w = out.append

    w('=' * 100)
    w('BTCUSD 5-MINUTE MOVE TIMETABLE  (Delta Exchange India)')
    w('=' * 100)
    w(f'Record          : {first_d} to {last_d}  ({len(dates):,} days, {len(bars):,} five-minute bars)')
    w(f'Timezone        : IST (Asia/Kolkata) -- the strategy is defined in IST')
    w(f'Generated       : {datetime.datetime.now(IST).strftime("%Y-%m-%d %H:%M")} IST')
    w('')
    w('move   = |close - open| / open, per cent. What the bar did end to end.')
    w('range  = (high - low)  / open, per cent. How far it travelled inside the')
    w('         bar -- this is what reaches a stop, and it is always the larger.')
    w('up%    = share of bars that closed higher than they opened.')
    w('')
    w('The two moments this desk is built around:')
    w('  05:30 IST  entry, when the daily contract opens')
    w('  17:29 IST  exit, one minute before the 17:30 settlement')
    w('')

    # ---------------------------------------------------------------- rankings
    slots = sorted(moves, key=lambda k: -st.fmean(moves[k]))
    w('=' * 100)
    w('THE 30 MOST ACTIVE FIVE-MINUTE SLOTS OF THE WEEK  (by average move)')
    w('=' * 100)
    w(f'{"#":>3}  {"DAY":<10} {"IST":>6}  {"N":>5}  {"AVG MV":>7}  {"MED":>6}  {"P95":>6}  {"MAX":>7}  {"AVG RNG":>8}')
    for i, k in enumerate(slots[:30], 1):
        wd, mod = k
        w(f'{i:>3}  {DAYS[wd]:<10} {mod//60:02d}:{mod%60:02d}  {len(moves[k]):>5}  '
          f'{st.fmean(moves[k]):>6.3f}%  {st.median(moves[k]):>5.3f}%  '
          f'{pct(moves[k],95):>5.3f}%  {max(moves[k]):>6.2f}%  {st.fmean(ranges[k]):>7.3f}%')
    w('')

    w('=' * 100)
    w('BY HOUR OF DAY  (all weekdays pooled)')
    w('=' * 100)
    w(f'{"IST HOUR":<10} {"N":>7}  {"AVG MOVE":>9}  {"MED":>7}  {"P95":>7}  {"AVG RANGE":>10}  {"UP%":>6}')
    for hr in range(24):
        mv = [x for k, v in moves.items() if k[1] // 60 == hr for x in v]
        rg = [x for k, v in ranges.items() if k[1] // 60 == hr for x in v]
        up = [x for k, v in ups.items() if k[1] // 60 == hr for x in v]
        if not mv:
            continue
        mark = ''
        if hr == 5:
            mark = '  <- entry 05:30'
        if hr == 17:
            mark = '  <- exit 17:29'
        w(f'{hr:02d}:00      {len(mv):>7,}  {st.fmean(mv):>8.4f}%  {st.median(mv):>6.4f}%  '
          f'{pct(mv,95):>6.3f}%  {st.fmean(rg):>9.4f}%  {st.fmean(up)*100:>5.1f}%{mark}')
    w('')

    w('=' * 100)
    w('BY DAY OF WEEK')
    w('=' * 100)
    w(f'{"DAY":<10} {"N":>8}  {"AVG MOVE":>9}  {"MED":>7}  {"P95":>7}  {"AVG RANGE":>10}  {"UP%":>6}')
    for wd in range(7):
        mv = [x for k, v in moves.items() if k[0] == wd for x in v]
        rg = [x for k, v in ranges.items() if k[0] == wd for x in v]
        up = [x for k, v in ups.items() if k[0] == wd for x in v]
        w(f'{DAYS[wd]:<10} {len(mv):>8,}  {st.fmean(mv):>8.4f}%  {st.median(mv):>6.4f}%  '
          f'{pct(mv,95):>6.3f}%  {st.fmean(rg):>9.4f}%  {st.fmean(up)*100:>5.1f}%')
    w('')

    # ------------------------------------------------------- the whole table
    w('=' * 100)
    w('THE FULL TIMETABLE  --  every weekday x every five-minute slot')
    w('=' * 100)
    w('288 slots a day x 7 days = 2,016 rows. N is how many times that slot has')
    w('occurred in the record, so each row is an average over roughly that many')
    w('weeks. MAX is the worst single bar ever seen in that slot.')
    w('')
    for wd in range(7):
        w('')
        w('-' * 100)
        w(f'{DAYS[wd].upper()}')
        w('-' * 100)
        w(f'{"IST":>6}  {"N":>5}  {"AVG MOVE":>9}  {"MED":>7}  {"P95":>7}  {"MAX":>7}  {"AVG RANGE":>10}  {"P95 RNG":>8}  {"UP%":>6}')
        for mod in range(0, 1440, 5):
            k = (wd, mod)
            if k not in moves:
                continue
            mv, rg, up = moves[k], ranges[k], ups[k]
            mark = ''
            if mod == 5 * 60 + 30:
                mark = '  <- ENTRY'
            if mod == 17 * 60 + 25:
                mark = '  <- EXIT window'
            w(f'{mod//60:02d}:{mod%60:02d}  {len(mv):>5}  {st.fmean(mv):>8.4f}%  '
              f'{st.median(mv):>6.4f}%  {pct(mv,95):>6.3f}%  {max(mv):>6.2f}%  '
              f'{st.fmean(rg):>9.4f}%  {pct(rg,95):>7.3f}%  {st.fmean(up)*100:>5.1f}%{mark}')
    w('')

    # ------------------------------------------------------- per-date summary
    w('=' * 100)
    w('EVERY DATE IN THE RECORD')
    w('=' * 100)
    w(f'{"DATE":<12} {"DAY":<10} {"BARS":>5}  {"AVG MOVE":>9}  {"MAX BAR":>8}  {"AVG RANGE":>10}  {"DAY RANGE":>10}')
    for d in sorted(per_date):
        v = per_date[d]
        w(f'{d:<12} {DAYS[v["wd"]]:<10} {len(v["mv"]):>5}  {st.fmean(v["mv"]):>8.4f}%  '
          f'{max(v["mv"]):>7.3f}%  {st.fmean(v["rg"]):>9.4f}%  {sum(v["rg"]):>9.2f}%')
    w('')
    w('=' * 100)
    w('END')
    w('=' * 100)

    text = '\n'.join(out) + '\n'
    with open(a.out, 'w') as f:
        f.write(text)
    print(f'wrote {len(out):,} lines -> {a.out}', file=sys.stderr)


if __name__ == '__main__':
    main()
