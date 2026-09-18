"""
Does the option chain say anything about where BTC settles? — 17 September 2026.

The Outlook cards are measured from candles alone. Asked on 17 September to use
the chain too (OI, volume, ΔOI, IV, skew, PCR ...), this measures every chain
reading that *has a history* the same way the candle states were measured, and
keeps only what held.

  History     chain.db: 733 mornings, every strike's mark and eight hours of
              volume at 05:30 IST, and the 17:30 settle twelve hours later.
  Outcome     settle ÷ spot − 1, as Down / Side / Up against the tercile of
              |move| -- so with no information the split is 33 / 33 / 33.
  Readings    implied move, skew, put/call volume (`analytics/app/chain_features.py`),
              each cut at its own terciles over the whole history.

  A reading is kept only if, like the candle states, it
    * points the same way in 2024, 2025 and 2026 separately by 3+ points, and
    * clears z > 3.

  One difference, stated: a year here needs 30 mornings in a bucket, not 50.
  The candle states count overlapping five-minute windows, where 50 is small;
  these are separate days, and a tercile of 2024's four months is about 40.

  Not measurable, and why: open interest per strike, its change, walls and max
  pain -- chain.db has none of them (the `oi` table is the two strikes the
  strategy sold, not the board). The desk records them every five minutes since
  17 September; `measure` again once there is a year.

Writes `chain_states` into CHAIN_DB (the repo's chain.db by default) and a report
beside this script. Pure Python.
"""
import json, math, os, sqlite3, sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'analytics'))
from app.chain_features import BUCKETS, SKEW_STEPS, bucket, implied_move_pct, put_call_volume, skew

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get('CHAIN_DB') or os.path.join(HERE, '..', 'chain.db')
REPORT = os.path.join(HERE, 'CHAIN-MEASURED.txt')
YEARS = ['2024', '2025', '2026']
MIN_PER_YEAR = 30
MINUTES = 720


def main() -> None:
    src = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    days = src.execute('SELECT date, spot, settle, atm, step FROM days ORDER BY date').fetchall()
    samples = []  # (year, ret, {feature: value})
    for date, spot, settle, atm, step in days:
        if not (spot > 0 and settle > 0):
            continue
        marks = {(cp, k): (mark, vol) for cp, k, mark, vol in
                 src.execute('SELECT cp, k, mark, vol_8h FROM legs WHERE date = ?', (date,))}
        c0, p0 = marks.get(('C', atm), (None, 0))[0], marks.get(('P', atm), (None, 0))[0]
        puts = [marks.get(('P', atm - n * step), (None, 0))[0] for n in SKEW_STEPS]
        calls = [marks.get(('C', atm + n * step), (None, 0))[0] for n in SKEW_STEPS]
        pv = sum(v or 0 for (cp, k), (_, v) in marks.items() if cp == 'P' and k < atm)
        cv = sum(v or 0 for (cp, k), (_, v) in marks.items() if cp == 'C' and k > atm)
        feats = {
            'implied_move': implied_move_pct(c0, p0, spot, 12.0),
            'skew': skew(puts, calls),
            'pcr_volume': put_call_volume(pv, cv),
        }
        samples.append((date[:4], settle / spot - 1, feats))

    rets = sorted(abs(r) for _, r, _ in samples)
    tau = rets[len(rets) // 3]

    def share(c):
        t = sum(c)
        return (c[0] / t, c[1] / t, c[2] / t) if t else (None, None, None)

    def quant(xs, q):
        xs = sorted(xs)
        return xs[min(len(xs) - 1, int(q * len(xs)))] * 100 if xs else None

    report = [
        f"Down / Side / Up at the 17:30 settle, from the 05:30 chain — {len(samples)} mornings "
        f"({samples[0][0]}–{samples[-1][0]}).",
        f"Side = within ±{tau*100:.3f}% (the tercile of |05:30 → 17:30|), so no information reads 33/33/33.",
        f"Kept only if the same way in {', '.join(YEARS)} by 3+ points ({MIN_PER_YEAR}+ mornings a year) and z > 3.",
        "",
    ]
    rows = []
    measured_at = datetime.now(timezone.utc).isoformat()

    def group(feature, name, lo, hi, members):
        counts = {'all': [0, 0, 0], **{y: [0, 0, 0] for y in YEARS}}
        moves = []
        for yr, r, _ in members:
            k = 0 if r < -tau else 2 if r > tau else 1
            counts['all'][k] += 1
            if yr in counts:
                counts[yr][k] += 1
            moves.append(r)
        d, s, u = share(counts['all'])
        n = sum(counts['all'])
        if not n:
            return
        tilt = u - d
        z = tilt / math.sqrt(max((u + d) / n, 1e-12))
        side_z = (s - 1 / 3) / math.sqrt((1 / 3) * (2 / 3) / n)
        years = {}
        for y in YEARS:
            yd, ys, yu = share(counts[y])
            years[y] = None if yd is None else {'down': yd, 'side': ys, 'up': yu, 'n': sum(counts[y])}
        ok = lambda y: years[y] is not None and years[y]['n'] >= MIN_PER_YEAR
        lean_way = all(ok(y) and (years[y]['up'] - years[y]['down']) * (1 if tilt >= 0 else -1) >= 0.03 for y in YEARS)
        side_way = all(ok(y) and (years[y]['side'] - 1 / 3) * (1 if s >= 1 / 3 else -1) >= 0.03 for y in YEARS)
        lean_holds = feature != 'any' and lean_way and abs(z) > 3
        side_holds = feature != 'any' and side_way and abs(side_z) > 3
        rows.append((MINUTES, feature, name, lo, hi, n, n, tau * 100, d, s, u,
                     quant(moves, 0.16), quant(moves, 0.5), quant(moves, 0.84),
                     json.dumps(years), int(lean_holds), int(side_holds), round(z, 2), round(side_z, 2), measured_at))
        yrs = ' '.join(f"{y}:{years[y]['up']-years[y]['down']:+.3f}/{years[y]['side']:.2f}" if years[y] else f'{y}:—' for y in YEARS)
        flag = (' <- LEAN HOLDS' if lean_holds else '') + (' <- SIDE HOLDS' if side_holds else '')
        report.append(f"  {feature:13s}{name:13s} n={n:>4}  down {d:.3f} side {s:.3f} up {u:.3f}  "
                      f"lean {tilt:+.3f} z={z:+.2f}  side z={side_z:+.2f}  [{yrs}]{flag}")

    group('any', 'all', None, None, samples)
    for feature, names in BUCKETS.items():
        have = [x for x in samples if x[2][feature] is not None]
        vals = sorted(x[2][feature] for x in have)
        if len(vals) < 90:
            report.append(f"  {feature}: only {len(vals)} mornings with a reading — not measured")
            continue
        lo, hi = vals[len(vals) // 3], vals[2 * len(vals) // 3]
        report.append(f"== {feature}  (terciles {lo:.4f} / {hi:.4f}, {len(vals)} mornings)")
        for name in names:
            group(feature, name, lo, hi, [x for x in have if bucket(x[2][feature], lo, hi, names) == name])
        report.append('')

    held = [r for r in rows if r[15] or r[16]]
    report.append(f"{len(held)} of {len(rows) - 1} chain readings held up in all three years.")
    report.append("Not measurable yet (no history): open interest per strike, ΔOI, OI walls, max pain, "
                  "V/OI, EV, touch, near-zero — recorded every 5 minutes from 17 Sep 2026.")

    out = sqlite3.connect(DB)
    out.execute('DROP TABLE IF EXISTS chain_states')
    out.execute('''CREATE TABLE chain_states (
      minutes INTEGER, feature TEXT, bucket TEXT, lo REAL, hi REAL, windows INTEGER, independent INTEGER,
      side_band_pct REAL, p_down REAL, p_side REAL, p_up REAL, q16_pct REAL, q50_pct REAL, q84_pct REAL,
      by_year TEXT, lean_holds INTEGER, side_holds INTEGER, lean_z REAL, side_z REAL, measured_at TEXT,
      PRIMARY KEY (minutes, feature, bucket))''')
    out.executemany('INSERT INTO chain_states VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
    out.commit()
    open(REPORT, 'w').write('\n'.join(report) + '\n')
    print('\n'.join(report))


if __name__ == '__main__':
    main()
