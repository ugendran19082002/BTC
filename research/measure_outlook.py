"""
Down / Side / Up, measured — for the Outlook cards, 17 September 2026.

For each horizon (5m ... 24h) and each observable state at the start of the
window, count how BTC actually finished: down more than the Side band, inside
it, or up more than it.

  Side band   the tercile of |return| for that horizon, so that with no
              information the split is 33 / 33 / 33. Any lean away from that
              is what a state is worth.

  States      only things the live desk can compute the same way from the
              candles it already fetches, with no look-ahead:
                momentum  the move over the previous window of the same length
                rsi       RSI(14) on the matching timeframe's last closed bar
                ema       the 9/21/50 EMA stack on that timeframe

  A lean is kept only if it
    * points the same way in 2024, 2025 and 2026 separately, by 3+ points, and
    * clears z > 3 on the *non-overlapping* sample (overlapping windows share
      most of their path, so counting every 5-minute start inflates z).

Everything else reads as "no reliable lean" on the card. Writes the table
`outlook_states` into chain.db and a readable report beside this script.

Pure Python: numpy is not installed on this box.
"""
import sys, csv, math, sqlite3, json, os, time
# The features live in the analytics service, so research and the live desk share one copy.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'analytics'))
from datetime import datetime, timezone, timedelta
from app.features import ema_series, rsi_series, stack_bucket, rsi_bucket, momentum_bucket

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, 'move-5min.csv')
# CHAIN_DB picks a different database (the production volume, say); the repo's copy by default.
DB = os.environ.get('CHAIN_DB') or os.path.join(HERE, '..', 'chain.db')
REPORT = os.path.join(HERE, 'OUTLOOK-MEASURED.txt')

HORIZONS = [5, 15, 30, 60, 120, 240, 360, 720, 1440]
# the timeframe whose indicators describe each horizon (the desk fetches these)
TF_FOR = {5: 5, 15: 15, 30: 15, 60: 60, 120: 60, 240: 240, 360: 240, 720: 1440, 1440: 1440}
YEARS = ['2024', '2025', '2026']
IST = timedelta(hours=5, minutes=30)

t0 = time.time()
ts, closes = [], []
with open(CSV) as f:
    for r in csv.DictReader(f):
        dt = datetime.strptime(f"{r['date_ist']} {r['time_ist']}", '%Y-%m-%d %H:%M') - IST
        ts.append(int(dt.replace(tzinfo=timezone.utc).timestamp()))
        closes.append(float(r['close']))
N = len(ts)
at = {t: i for i, t in enumerate(ts)}
year_of = [(datetime.fromtimestamp(t, timezone.utc) + IST).strftime('%Y') for t in ts]
print(f"loaded {N} bars in {time.time()-t0:.1f}s", flush=True)

# ---- timeframe bars, EMA stack and RSI, aligned to UTC like Delta's candles
tf_state = {}
for tf in sorted(set(TF_FOR.values())):
    sec = tf * 60
    bar_end, bar_close = [], []
    for t, c in zip(ts, closes):
        end = (t // sec + 1) * sec                      # the bar this 5m bar belongs to closes at `end`
        if bar_end and bar_end[-1] == end: bar_close[-1] = c
        else: bar_end.append(end); bar_close.append(c)
    e9, e21, e50 = ema_series(bar_close, 9), ema_series(bar_close, 21), ema_series(bar_close, 50)
    rs = rsi_series(bar_close)
    tf_state[tf] = (bar_end, e9, e21, e50, rs)

def indicators(tf, now):
    """The last bar of `tf` that has closed by `now`, never the one still forming."""
    bar_end, e9, e21, e50, rs = tf_state[tf]
    lo, hi = 0, len(bar_end) - 1; j = -1
    while lo <= hi:
        m = (lo + hi) // 2
        if bar_end[m] <= now: j = m; lo = m + 1
        else: hi = m - 1
    if j < 0: return None, None
    return stack_bucket(e9[j], e21[j], e50[j]), rsi_bucket(rs[j])

rows = []
report = [f"Down / Side / Up, measured over {N:,} five-minute bars "
          f"({(datetime.fromtimestamp(ts[0], timezone.utc)+IST):%d %b %Y} to {(datetime.fromtimestamp(ts[-1], timezone.utc)+IST):%d %b %Y}).",
          "Side = within the tercile of |move| for that horizon, so no information reads 33/33/33.",
          "A lean is kept only if it points the same way in 2024, 2025 and 2026 by 3+ points and clears z>3 on non-overlapping windows.", ""]

for h in HORIZONS:
    n = h // 5
    rets = []                                        # (i, r) for every start with a bar exactly h later
    for i in range(N):
        j = at.get(ts[i] + h * 60)
        if j is not None and closes[i] > 0: rets.append((i, closes[j] / closes[i] - 1))
    absr = sorted(abs(r) for _, r in rets)
    tau = absr[len(absr) // 3]                       # tercile: Side is a third of all windows
    groups = {}
    def add(key, yr, r):
        g = groups.setdefault(key, {'all': [0, 0, 0], **{y: [0, 0, 0] for y in YEARS}, 'hist': {}})
        k = 0 if r < -tau else 2 if r > tau else 1
        g['all'][k] += 1
        if yr in g: g[yr][k] += 1
        b = round(r * 10000)                         # 0.01% bins, for quantiles without keeping every return
        g['hist'][b] = g['hist'].get(b, 0) + 1
    for i, r in rets:
        yr = year_of[i]; now = ts[i] + 300
        add(('any', 'all'), yr, r)
        jprev = at.get(ts[i] - (n - 1) * 300) if n > 1 else i
        if jprev is not None and i >= 1:
            base = closes[jprev - 1] if jprev - 1 >= 0 else None
            if base:
                m = closes[i] / base - 1
                add(('momentum', momentum_bucket(m, tau)), yr, r)
        stack, rsi = indicators(TF_FOR[h], now)
        if stack: add(('ema', stack), yr, r)
        if rsi: add(('rsi', rsi), yr, r)

    def share(c):
        t = sum(c); return (c[0] / t, c[1] / t, c[2] / t) if t else (None, None, None)
    def quant(hist, q):
        total = sum(hist.values()); acc = 0
        for b in sorted(hist):
            acc += hist[b]
            if acc >= q * total: return b / 100    # back to percent
        return None

    report.append(f"== {h}m ==  Side band ±{tau*100:.3f}%   windows {len(rets):,}")
    for (feat, bucket), g in sorted(groups.items()):
        d, s, u = share(g['all']); tot = sum(g['all'])
        eff = tot / n                                # non-overlapping sample size
        tilt = u - d
        z = tilt / math.sqrt(max((u + d) / eff, 1e-12)) if eff > 0 else 0
        years = {}
        for y in YEARS:
            yd, ys, yu = share(g[y])
            years[y] = None if yd is None else {'down': yd, 'side': ys, 'up': yu, 'n': sum(g[y])}
        same_way = all(years[y] and years[y]['n'] >= 50 and (years[y]['up'] - years[y]['down']) * (1 if tilt >= 0 else -1) >= 0.03 for y in YEARS)
        side_z = (s - 1/3) / math.sqrt((1/3) * (2/3) / eff) if eff > 0 else 0
        side_way = all(years[y] and years[y]['n'] >= 50 and (years[y]['side'] - 1/3) * (1 if s >= 1/3 else -1) >= 0.03 for y in YEARS)
        passes = feat != 'any' and same_way and abs(z) > 3
        calmer = feat != 'any' and side_way and abs(side_z) > 3
        rows.append((h, feat, bucket, tot, round(eff), tau * 100, d, s, u,
                     quant(g['hist'], 0.16), quant(g['hist'], 0.5), quant(g['hist'], 0.84),
                     json.dumps(years), int(passes), int(calmer), round(z, 2), round(side_z, 2)))
        flag = ' <- LEAN HOLDS' if passes else ''
        flag += ' <- SIDE HOLDS' if calmer else ''
        yrs = ' '.join(f"{y}:{years[y]['up']-years[y]['down']:+.3f}" if years[y] else f"{y}:—" for y in YEARS)
        report.append(f"  {feat:9s}{bucket:11s} n={tot:>7,}  down {d:.3f} side {s:.3f} up {u:.3f}  "
                      f"lean {tilt:+.3f} z={z:+.2f}  side z={side_z:+.2f}  [{yrs}]{flag}")
    report.append("")
    print(f"{h}m done ({time.time()-t0:.0f}s)", flush=True)

db = sqlite3.connect(DB)
db.execute('DROP TABLE IF EXISTS outlook_states')
db.execute('''CREATE TABLE outlook_states (
  minutes INTEGER, feature TEXT, bucket TEXT, windows INTEGER, independent INTEGER, side_band_pct REAL,
  p_down REAL, p_side REAL, p_up REAL, q16_pct REAL, q50_pct REAL, q84_pct REAL,
  by_year TEXT, lean_holds INTEGER, side_holds INTEGER, lean_z REAL, side_z REAL,
  measured_at TEXT, PRIMARY KEY (minutes, feature, bucket))''')
now = datetime.now(timezone.utc).isoformat()
db.executemany('INSERT INTO outlook_states VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [r + (now,) for r in rows])
db.commit()
held = [r for r in rows if r[13] or r[14]]
report.append(f"{len(held)} of {len([r for r in rows if r[1] != 'any'])} state readings held up in all three years.")
open(REPORT, 'w').write('\n'.join(report) + '\n')
print(f"wrote {len(rows)} rows; {len(held)} held; {time.time()-t0:.0f}s total")
