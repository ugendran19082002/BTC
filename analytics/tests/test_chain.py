"""
The option chain as measured states: defined once, bucketed at the stored cut
points, and allowed to move a figure only on the settlement card and only where
it held.
"""
import math

import pytest

from app import chain_features as cf
from app import outlook as model

NOW = 1_789_600_000
SPOT = 76_000.0


def board(**over):
    """A board with a large implied move (straddle 1.3% of spot at 12h), even skew and volume."""
    b = {'spot': SPOT, 'hours_left': 12.0, 'call_atm': 500.0, 'put_atm': 488.0,
         'put_marks': [200.0, 130.0, 80.0], 'call_marks': [198.0, 128.0, 84.0],
         'put_volume': 10_000.0, 'call_volume': 10_500.0}
    b.update(over)
    return b


def test_implied_move_is_scaled_to_twelve_hours_by_root_time():
    at_12h = cf.implied_move_pct(500, 500, 100_000, 12)
    assert at_12h == pytest.approx(1.0)
    # the same straddle with 3 hours left is a move twice the size, per √t
    assert cf.implied_move_pct(500, 500, 100_000, 3) == pytest.approx(2.0)


def test_a_missing_or_zero_mark_is_no_reading_not_a_small_one():
    assert cf.implied_move_pct(None, 500, 100_000, 12) is None
    assert cf.implied_move_pct(0, 500, 100_000, 12) is None
    assert cf.implied_move_pct(500, 500, 100_000, 0) is None
    assert cf.skew([1, 2, None], [1, 2, 3]) is None
    assert cf.skew([1, 2], [1, 2, 3]) is None


def test_skew_is_signed_and_bounded():
    assert cf.skew([3, 2, 1], [1, 1, 1]) == pytest.approx((6 - 3) / 9)
    assert cf.skew([1, 1, 1], [3, 2, 1]) == pytest.approx(-(6 - 3) / 9)
    assert cf.skew([1, 1, 1], [1, 1, 1]) == 0


def test_put_call_volume_is_a_log_so_twice_either_way_is_the_same_distance():
    assert cf.put_call_volume(200, 100) == pytest.approx(math.log(2))
    assert cf.put_call_volume(100, 200) == pytest.approx(-math.log(2))
    assert cf.put_call_volume(0, 100) is None


def test_buckets_use_the_stored_cut_points():
    names = cf.BUCKETS['implied_move']
    assert cf.bucket(0.5, 0.7368, 1.043, names) == 'small'
    assert cf.bucket(0.9, 0.7368, 1.043, names) == 'usual'
    assert cf.bucket(1.3, 0.7368, 1.043, names) == 'large'
    assert cf.bucket(None, 0.7368, 1.043, names) is None


def test_the_chain_loads_with_its_cut_points(chain_rows):
    large = chain_rows[('implied_move', 'large')]
    assert large.lo == pytest.approx(0.7368) and large.hi == pytest.approx(1.043)
    assert large.side_holds and not large.lean_holds


def test_a_database_without_chain_states_still_serves_the_candle_cards(tmp_path):
    import sqlite3
    from app.db import States
    from tests.conftest import SCHEMA
    p = tmp_path / 'old.db'
    con = sqlite3.connect(p); con.execute(SCHEMA); con.commit(); con.close()
    assert States(str(p)).chain() == {}


def test_critical_a_large_implied_move_makes_the_settlement_card_livelier(rows, chain_rows):
    out = model.outlook(spot=SPOT, now=NOW, series={}, rows=rows, extra=[('to settlement · 12h', 720)],
                        chain_rows=chain_rows, chain=board())
    settle = out['rows'][-1]
    assert settle['basis']['words'] == 'Options price a large move to settlement'
    assert settle['calm'] == 'livelier'
    assert settle['p_side'] == pytest.approx(0.193, abs=1e-3)
    # no chain reading held a direction, so Down and Up split the rest evenly and no arrow is drawn
    assert settle['p_down'] == pytest.approx(settle['p_up'])
    assert settle['arrow'] == 'flat'
    # the band is the chain's own: 05:30 -> settle, not any twelve hours
    assert settle['side_band_pct'] == pytest.approx(0.378)
    assert settle['high'] - settle['low'] == pytest.approx(SPOT * 0.029)
    assert out['model'] == 'measured-states-v2'


def test_critical_the_chain_never_speaks_on_the_candle_horizons(rows, chain_rows):
    with_chain = model.outlook(spot=SPOT, now=NOW, series={}, rows=rows, chain_rows=chain_rows, chain=board())
    without = model.outlook(spot=SPOT, now=NOW, series={}, rows=rows)
    assert [r['p_side'] for r in with_chain['rows']] == [r['p_side'] for r in without['rows']]


def test_an_unheld_chain_reading_changes_nothing(rows, chain_rows):
    # a usual implied move and puts dearer: both measured, neither held
    out = model.outlook(spot=SPOT, now=NOW, series={}, rows=rows, extra=[('to settlement · 12h', 720)],
                        chain_rows=chain_rows, chain=board(call_atm=400.0, put_atm=300.0, put_marks=[300.0, 200.0, 150.0]))
    settle = out['rows'][-1]
    assert settle['basis'] is None
    assert (settle['p_down'], settle['p_side'], settle['p_up']) == pytest.approx((0.333, 0.334, 0.333))


def test_context_reports_every_reading_and_whether_it_held(rows, chain_rows):
    out = model.outlook(spot=SPOT, now=NOW, series={}, rows=rows, extra=[('to settlement · 12h', 720)],
                        chain_rows=chain_rows, chain=board(put_volume=30_000.0))
    ctx = {c['feature']: c for c in out['context']}
    assert set(ctx) == {'implied_move', 'skew', 'pcr_volume'}
    assert ctx['implied_move']['bucket'] == 'large' and ctx['implied_move']['side_holds'] is True
    assert ctx['implied_move']['calm'] == 'livelier'
    assert ctx['pcr_volume']['bucket'] == 'more_puts'
    assert ctx['pcr_volume']['words'] == 'More puts than calls are trading'
    assert ctx['pcr_volume']['lean_holds'] is False and ctx['pcr_volume']['measured'] is True
    assert ctx['skew']['bucket'] == 'even'


def test_no_board_means_no_context_and_the_old_model(rows, chain_rows):
    out = model.outlook(spot=SPOT, now=NOW, series={}, rows=rows, chain_rows=chain_rows, chain=None)
    assert out['context'] == []
