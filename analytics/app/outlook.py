"""
Where BTC may be at each horizon — Down / Side / Up, measured.

For every card this labels "now" the way `research/measure_outlook.py` labelled
280,326 five-minute bars of history (with the very same functions, from
`features.py`), finds the rows of `outlook_states` that match, and reports what
followed moments like this one.

## What a card shows, and the one rule behind it

  **Only what held.** A state's reading counts only for the part of it that
  pointed the same way in 2024, 2025 and 2026 with z > 3 on non-overlapping
  windows:

    side held   Side is the measured share; Down and Up split the rest evenly
    lean held   Down and Up keep the measured lean; Side is the no-information third
    both        all three as measured
    neither     not used

  With no state holding, the card shows the unconditional split — near 33/33/33,
  because the Side band is the tercile of |move|. Arrows follow only a lean that
  held, which on this data means short horizons and mean reversion: after a drop,
  up is favoured, not down.

  **The chain** (17 September) joins only the settlement card, because that is
  the horizon it was measured on: the 05:30 board against the 17:30 settle, 735
  mornings. Its readings compete with the candle states on the same rule --
  the most informative reading that held wins -- each against its own
  unconditional split. Of implied move, skew and put/call volume, only a large
  implied move held (livelier: Side 19%, not 33%); no chain reading held a
  direction. Every card response also carries `context`: each chain reading
  now, its bucket, and whether it held, so the screen can show the board
  without letting an unheld reading move a figure.

  **The projected price** moves off spot only when a lean held (the measured
  median return for that state); otherwise it is spot plus the unconditional
  median, which is a few dollars. **The range** is the measured 16th to 84th
  percentile of the return — narrower in a state measured as calmer.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from .chain_features import BUCKETS as CHAIN_BUCKETS, bucket as chain_bucket
from .chain_features import implied_move_pct, put_call_volume, skew
from .db import ChainRow, StateRow
from .features import ema_series, momentum_bucket, rsi_bucket, rsi_series, stack_bucket

HORIZONS: list[tuple[str, int]] = [
    ('5m', 5), ('15m', 15), ('30m', 30), ('1h', 60), ('2h', 120),
    ('4h', 240), ('6h', 360), ('12h', 720), ('24h', 1440),
]
MEASURED_MINUTES = [m for _, m in HORIZONS]
# The timeframe whose indicators describe a horizon -- the same map the measurement used.
TF_FOR = {5: '5m', 15: '15m', 30: '15m', 60: '1h', 120: '1h', 240: '4h', 360: '4h', 720: '1d', 1440: '1d'}
TF_SEC = {'5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400}
FEATURES = ('momentum', 'rsi', 'ema')

HORIZON_WORDS = {5: '5 minutes', 15: '15 minutes', 30: '30 minutes', 60: 'hour', 120: '2 hours',
                 240: '4 hours', 360: '6 hours', 720: '12 hours', 1440: '24 hours'}


def closed(times: list[int], closes: list[float], tf: str, now: int) -> list[float]:
    """Closes of bars that have finished by `now`. A bar still forming was never in the history."""
    sec = TF_SEC[tf]
    return [c for t, c in zip(times, closes) if t + sec <= now]


def nearest_measured(minutes: float) -> int:
    """The measured horizon closest in ratio, not in minutes: 9.6 hours is nearer 12h than 6h."""
    m = max(minutes, 1)
    return min(MEASURED_MINUTES, key=lambda h: abs(math.log(h / m)))


def live_state(minutes: int, series: dict[str, tuple[list[int], list[float]]], now: int, tau_pct: float) -> dict:
    """Label now for one horizon: momentum over the horizon, RSI and EMA stack on its timeframe."""
    state: dict = {'momentum': None, 'rsi': None, 'ema': None, 'move_pct': None, 'rsi_value': None}
    tf = TF_FOR[minutes]
    if tf in series:
        cs = closed(*series[tf], tf, now)
        if len(cs) >= 15:
            r = rsi_series(cs)[-1]
            state['rsi'], state['rsi_value'] = rsi_bucket(r), r
        if len(cs) >= 50:
            state['ema'] = stack_bucket(ema_series(cs, 9)[-1], ema_series(cs, 21)[-1], ema_series(cs, 50)[-1])
    # Momentum over the horizon itself: five-minute bars while they reach back that far,
    # hourly bars beyond (the desk keeps 220 of each).
    for tf2, step in (('5m', 300), ('1h', 3600)):
        if tf2 not in series or (minutes * 60) % step:
            continue
        n = minutes * 60 // step
        cs = closed(*series[tf2], tf2, now)
        if len(cs) > n and cs[-1 - n] > 0:
            move = cs[-1] / cs[-1 - n] - 1
            state['momentum'], state['move_pct'] = momentum_bucket(move, tau_pct / 100), move * 100
            break
    return state


@dataclass
class Shown:
    p_down: float
    p_side: float
    p_up: float
    lean: bool
    side: bool


def shown(row: StateRow, unconditional: StateRow) -> Shown | None:
    """What of a state's reading may be shown: only the parts that held."""
    if not (row.lean_holds or row.side_holds):
        return None
    side = row.p_side if row.side_holds else unconditional.p_side
    tilt = (row.p_up - row.p_down) if row.lean_holds else 0.0
    rest = 1 - side
    down = max(0.0, rest / 2 - tilt / 2)
    up = max(0.0, rest / 2 + tilt / 2)
    total = down + side + up
    return Shown(down / total, side / total, up / total, row.lean_holds, row.side_holds)


def informativeness(s: Shown) -> float:
    """How far a reading is from "no information", 0 at an even three-way split."""
    third = 1 / 3
    return (abs(s.p_down - third) + abs(s.p_side - third) + abs(s.p_up - third)) / 2


BUCKET_WORDS = {
    ('momentum', 'down'): 'BTC fell over the last {h}',
    ('momentum', 'up'): 'BTC rose over the last {h}',
    ('momentum', 'flat'): 'BTC was quiet over the last {h}',
    ('rsi', 'oversold'): '{tf} RSI is oversold',
    ('rsi', 'overbought'): '{tf} RSI is overbought',
    ('rsi', 'neutral'): '{tf} RSI is in the middle',
    ('ema', 'rising'): '{tf} EMAs are rising',
    ('ema', 'falling'): '{tf} EMAs are falling',
    ('ema', 'mixed'): '{tf} EMAs are crossed',
}


def card(label: str, minutes: float, spot: float, rows: dict, series: dict, now: int,
         chain_rows: dict | None = None, chain_state: dict | None = None) -> dict | None:
    """One card. `chain_rows` / `chain_state` are passed only for the settlement card."""
    h = nearest_measured(minutes)
    base = rows.get((h, 'any', 'all'))
    if base is None:
        return None
    state = live_state(h, series, now, base.side_band_pct)

    # (row, what may be shown, the unconditional split that row is read against)
    best_row, best, best_base = None, None, base
    for feat in FEATURES:
        bucket = state[feat]
        row = rows.get((h, feat, bucket)) if bucket else None
        s = shown(row, base) if row else None
        if s and (best is None or informativeness(s) > informativeness(best)):
            best_row, best, best_base = row, s, base
    chain_base = (chain_rows or {}).get(('any', 'all'))
    if chain_base is not None:
        for feat, bucket in (chain_state or {}).items():
            row = chain_rows.get((feat, bucket)) if bucket else None
            s = shown(row, chain_base) if row else None
            if s and (best is None or informativeness(s) > informativeness(best)):
                best_row, best, best_base = row, s, chain_base
    # A chain reading carries its own Side band and quantiles: 05:30 → settle, not any 12 hours.
    base = best_base

    if best is None:
        chosen, p = base, Shown(base.p_down, base.p_side, base.p_up, False, False)
    else:
        chosen, p = best_row, best

    # The price moves off spot only on a lean that held; the band narrows only on a side that held.
    q50 = (chosen.q50_pct if p.lean else base.q50_pct) or 0.0
    q_from = chosen if p.side else base
    low = spot * (1 + (q_from.q16_pct or 0.0) / 100)
    high = spot * (1 + (q_from.q84_pct or 0.0) / 100)
    arrow = 'flat'
    if p.lean:
        arrow = 'up' if p.p_up > p.p_down else 'down' if p.p_down > p.p_up else 'flat'
    calm = None
    if p.side:
        calm = 'calmer' if p.p_side > base.p_side else 'livelier'

    basis = None
    if best is not None:
        basis = {
            'feature': chosen.feature,
            'bucket': chosen.bucket,
            'words': (CHAIN_WORDS.get((chosen.feature, chosen.bucket)) or
                      BUCKET_WORDS.get((chosen.feature, chosen.bucket), f'{chosen.feature} {chosen.bucket}'))
            .format(h=HORIZON_WORDS[h], tf=TF_FOR[h]),
            'windows': chosen.windows,
            'independent': chosen.independent,
            'lean_holds': p.lean,
            'side_holds': p.side,
        }

    return {
        'label': label,
        'minutes': minutes,
        'measured_minutes': h,
        'spot': spot,
        'projected': spot * (1 + q50 / 100),
        'low': min(low, high),
        'high': max(low, high),
        'p_down': p.p_down,
        'p_side': p.p_side,
        'p_up': p.p_up,
        'side_band_pct': base.side_band_pct,
        'side_band_usd': spot * base.side_band_pct / 100,
        'arrow': arrow,
        'calm': calm,
        'basis': basis,
        'windows': chosen.windows,
        'state': {k: state[k] for k in ('momentum', 'rsi', 'ema', 'move_pct', 'rsi_value')},
    }


CHAIN_WORDS = {
    ('implied_move', 'small'): 'Options price a small move to settlement',
    ('implied_move', 'usual'): 'Options price a usual move to settlement',
    ('implied_move', 'large'): 'Options price a large move to settlement',
    ('skew', 'puts_dearer'): 'Puts are dearer than calls',
    ('skew', 'even'): 'Puts and calls are priced evenly',
    ('skew', 'calls_dearer'): 'Calls are dearer than puts',
    ('pcr_volume', 'more_puts'): 'More puts than calls are trading',
    ('pcr_volume', 'even'): 'Puts and calls are trading evenly',
    ('pcr_volume', 'more_calls'): 'More calls than puts are trading',
}


def chain_values(chain: dict | None) -> dict[str, float | None]:
    """The raw board from the desk, turned into the three readings -- with the research's own functions."""
    if not chain:
        return {}
    return {
        'implied_move': implied_move_pct(chain.get('call_atm'), chain.get('put_atm'), chain.get('spot') or 0,
                                         chain.get('hours_left') or 0),
        'skew': skew(chain.get('put_marks') or [], chain.get('call_marks') or []),
        'pcr_volume': put_call_volume(chain.get('put_volume'), chain.get('call_volume')),
    }


def chain_states_now(values: dict[str, float | None], chain_rows: dict) -> dict[str, str | None]:
    """Each reading, cut at the terciles stored with its measurement."""
    out: dict[str, str | None] = {}
    for feat, names in CHAIN_BUCKETS.items():
        row = next((r for (f, _), r in chain_rows.items() if f == feat), None)
        if row is None or row.lo is None or row.hi is None:
            out[feat] = None
            continue
        out[feat] = chain_bucket(values.get(feat), row.lo, row.hi, names)
    return out


def context(values: dict[str, float | None], states: dict[str, str | None], chain_rows: dict) -> list[dict]:
    """The chain now, reading by reading, with what its measurement allows to be said about it."""
    base = chain_rows.get(('any', 'all'))
    out = []
    for feat in CHAIN_BUCKETS:
        b = states.get(feat)
        row = chain_rows.get((feat, b)) if b else None
        s = shown(row, base) if (row is not None and base is not None) else None
        out.append({
            'feature': feat,
            'value': values.get(feat),
            'bucket': b,
            'words': CHAIN_WORDS.get((feat, b)) if b else None,
            'measured': row is not None,
            'lean_holds': bool(s and s.lean),
            'side_holds': bool(s and s.side),
            'calm': None if not (s and s.side) else ('calmer' if s.p_side > base.p_side else 'livelier'),
            'p_down': row.p_down if row else None,
            'p_side': row.p_side if row else None,
            'p_up': row.p_up if row else None,
            'windows': row.windows if row else None,
        })
    return out


def outlook(*, spot: float, now: int, series: dict, rows: dict, extra: list[tuple[str, float]] = (),
            chain_rows: dict | None = None, chain: dict | None = None) -> dict:
    chain_rows = chain_rows or {}
    values = chain_values(chain)
    states = chain_states_now(values, chain_rows) if chain_rows and values else {}
    cards = [card(label, m, spot, rows, series, now) for label, m in HORIZONS]
    # The chain was measured to settlement, so it may only speak on the settlement card.
    cards += [card(label, m, spot, rows, series, now, chain_rows, states) for label, m in extra]
    measured_at = next(iter(rows.values())).measured_at if rows else None
    return {
        'model': 'measured-states-v2' if chain_rows else 'measured-states-v1',
        'measured_at': measured_at,
        'rows': [c for c in cards if c is not None],
        'context': context(values, states, chain_rows) if chain_rows and values else [],
    }
