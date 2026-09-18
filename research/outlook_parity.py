"""
Test vectors for the Node server: the same closes through the same features.

Writes analytics/tests/fixtures/outlook-parity.json. The service's
`analytics/tests/test_features.py` computes every figure in it again and must agree to
1e-9 -- so a change to either language's maths fails a test instead of quietly
labelling the live market differently from the history it is measured against.
"""
import sys, csv, json, os
# The features live in the analytics service, so research and the live desk share one copy.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'analytics'))
from app.features import ema_series, rsi_series, stack_bucket, rsi_bucket, momentum_bucket

HERE = os.path.dirname(os.path.abspath(__file__))
closes = []
with open(os.path.join(HERE, 'move-5min.csv')) as f:
    for r in csv.DictReader(f):
        closes.append(float(r['close']))
closes = closes[-400:]                         # a real recent stretch, not a synthetic line

e9, e21, e50, rs = ema_series(closes, 9), ema_series(closes, 21), ema_series(closes, 50), rsi_series(closes)
cases = []
for n, tau in [(1, 0.00035), (3, 0.00061), (12, 0.00119), (48, 0.00238)]:
    move = closes[-1] / closes[-1 - n] - 1
    cases.append({'bars': n, 'tau': tau, 'move': move, 'bucket': momentum_bucket(move, tau)})

out = {
    'closes': closes,
    'ema9_last': e9[-1], 'ema21_last': e21[-1], 'ema50_last': e50[-1], 'rsi_last': rs[-1],
    'ema9_at_60': e9[60], 'rsi_at_60': rs[60],
    'stack': stack_bucket(e9[-1], e21[-1], e50[-1]), 'rsi_bucket': rsi_bucket(rs[-1]),
    'momentum': cases,
    'rsi_edges': {str(v): rsi_bucket(v) for v in [29.99, 30.0, 70.0, 70.01]},
}
dest = os.path.join(HERE, '..', 'analytics', 'tests', 'fixtures', 'outlook-parity.json')
os.makedirs(os.path.dirname(dest), exist_ok=True)
json.dump(out, open(dest, 'w'), indent=1)
print('wrote', dest, '| stack', out['stack'], '| rsi', round(out['rsi_last'], 4), out['rsi_bucket'])
