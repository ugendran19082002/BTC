"""
The option chain as states, in one place.

`research/measure_chain_outlook.py` labels 733 mornings of history with these,
and the analytics service labels "now" with the very same functions, so a
measured reading can only ever be applied to a state defined the way it was
measured. The Node server sends the raw figures; it never buckets them.

Each function takes plain numbers, not a chain object, so the two callers --
a `legs` table in chain.db and a JSON board from the desk -- cannot disagree
about what went in.

## The three readings, and why only these three

    implied move   ATM call + ATM put, as a share of spot, scaled to 12 hours
    skew           out-of-the-money puts against the calls the same distance away
    put/call volume  traded puts against traded calls, out of the money

They are the chain figures that exist *in the history*. chain.db holds every
strike's mark and eight hours of volume at 05:30 for 733 days, and the 17:30
settle after it -- so these can be tested against what BTC then did. Open
interest per strike, its change, walls and max pain have no such history (the
desk has recorded them only since 14 September), so they cannot be measured yet
and are shown as context, never as odds.
"""
from __future__ import annotations

import math

# 2, 3 and 4 strikes from the money: far enough to be out of it, near enough to trade.
SKEW_STEPS = (2, 3, 4)
# The history's snapshot is taken 12 hours before settlement.
MEASURED_HOURS = 12.0


def implied_move_pct(call_atm: float | None, put_atm: float | None, spot: float, hours_left: float) -> float | None:
    """The ATM straddle as a share of spot, scaled by √t to what it would be with 12 hours left.

    A straddle is worth about 0.8 × the expected move, and the move grows with
    √t -- so dividing by √(hours ÷ 12) lets a reading at 14:00 be compared with
    the 05:30 readings it was measured on.
    """
    if call_atm is None or put_atm is None or not (spot > 0) or not (hours_left > 0):
        return None
    if call_atm <= 0 or put_atm <= 0:
        return None
    return (call_atm + put_atm) / spot * 100 / math.sqrt(hours_left / MEASURED_HOURS)


def skew(put_marks: list[float | None], call_marks: list[float | None]) -> float | None:
    """(puts − calls) ÷ (puts + calls) over the same distances: −1 … +1, positive when puts are dearer.

    Both lists are ordered by `SKEW_STEPS`. Any missing mark and there is no
    reading -- a partial sum would lean whichever side happened to be quoted.
    """
    if len(put_marks) != len(SKEW_STEPS) or len(call_marks) != len(SKEW_STEPS):
        return None
    if any(m is None or m <= 0 for m in put_marks) or any(m is None or m <= 0 for m in call_marks):
        return None
    p, c = sum(put_marks), sum(call_marks)  # type: ignore[arg-type]
    return (p - c) / (p + c)


def put_call_volume(put_volume: float | None, call_volume: float | None) -> float | None:
    """log(puts ÷ calls) of out-of-the-money volume: 0 is even, positive is more puts traded.

    A log so that "twice the puts" and "twice the calls" are the same distance
    from even. Null when either side traded nothing: a ratio against zero is
    not a lean, it is an empty board.
    """
    if not put_volume or not call_volume or put_volume <= 0 or call_volume <= 0:
        return None
    return math.log(put_volume / call_volume)


def bucket(value: float | None, lo: float, hi: float, names: tuple[str, str, str]) -> str | None:
    """Below `lo`, between, above `hi` -- the measured terciles, stored with the states."""
    if value is None:
        return None
    return names[0] if value < lo else names[2] if value > hi else names[1]


# The bucket names, low to high, per feature. Shared so the words cannot drift.
BUCKETS: dict[str, tuple[str, str, str]] = {
    'implied_move': ('small', 'usual', 'large'),
    'skew': ('calls_dearer', 'even', 'puts_dearer'),
    'pcr_volume': ('more_calls', 'even', 'more_puts'),
}
