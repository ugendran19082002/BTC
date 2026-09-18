"""
The measured model: label now like history, report what followed, show only what held.
"""
import pytest

from app import outlook as model

NOW = 1_789_600_000
H = 3600


def hourly(closes, end=NOW):
    """Closed hourly bars ending at `end`, oldest first, plus one still forming."""
    n = len(closes)
    start = (end // H) * H - n * H
    times = [start + i * H for i in range(n)] + [(end // H) * H]
    return times, list(closes) + [closes[-1] * 5]           # the forming bar is absurd on purpose


def test_a_bar_still_forming_is_never_read():
    t, c = hourly([100.0, 101.0])
    assert model.closed(t, c, '1h', NOW) == [100.0, 101.0]


def test_settlement_maps_to_the_nearest_measured_horizon_by_ratio():
    assert model.nearest_measured(9.6 * 60) == 720       # nearer 12h than 6h in ratio
    assert model.nearest_measured(7) == 5
    assert model.nearest_measured(3000) == 1440


def test_momentum_over_the_horizon_is_bucketed_on_the_side_band():
    t, c = hourly([100.0] * 60 + [99.0])                     # down 1% over the last hour
    state = model.live_state(60, {'1h': (t, c)}, NOW, tau_pct=0.119)
    assert state['momentum'] == 'down'
    assert state['move_pct'] == pytest.approx(-1.0)


def test_nothing_to_read_reads_as_no_state():
    state = model.live_state(60, {}, NOW, tau_pct=0.119)
    assert state['momentum'] is None and state['rsi'] is None and state['ema'] is None


def series_for_1h_drop():
    return {'1h': hourly([100.0] * 60 + [99.0])}


def test_both_held_shows_all_three_as_measured(rows):
    c = model.card('1h', 60, 75_000, rows, series_for_1h_drop(), NOW)
    assert (c['p_down'], c['p_side'], c['p_up']) == pytest.approx((0.337, 0.271, 0.392), abs=1e-9)
    assert c['arrow'] == 'up'                                # mean reversion: after a drop, up
    assert c['calm'] == 'livelier'
    assert c['basis']['words'] == 'BTC fell over the last hour'
    assert c['projected'] == pytest.approx(75_000 * 1.0002)  # the measured median, because the lean held


def test_only_side_held_splits_down_and_up_evenly_and_draws_no_arrow(rows):
    flat = {'1h': hourly([100.0] * 61)}
    c = model.card('1h', 60, 75_000, rows, flat, NOW)
    assert c['p_side'] == pytest.approx(0.436)
    assert c['p_down'] == pytest.approx(c['p_up'])           # the unheld lean is not shown
    assert c['arrow'] == 'flat'
    assert c['calm'] == 'calmer'
    # the band narrows on the calmer reading, the price does not move off the unconditional median
    assert c['high'] - c['low'] == pytest.approx(75_000 * 0.0024)
    assert c['projected'] == pytest.approx(75_000 * 1.00001)


def test_only_lean_held_keeps_the_lean_and_the_no_information_side(rows):
    down = rows[(5, 'rsi', 'oversold')]
    s = model.shown(down, rows[(5, 'any', 'all')])
    assert s.p_side == pytest.approx(0.334)
    assert s.p_up - s.p_down == pytest.approx(0.348 - 0.282)
    assert s.lean and not s.side


def test_a_reading_that_held_nothing_is_not_shown(rows):
    assert model.shown(rows[(60, 'ema', 'rising')], rows[(60, 'any', 'all')]) is None


def test_no_state_holding_falls_back_to_the_unconditional_split(rows):
    c = model.card('2h', 120, 75_000, rows, {}, NOW)
    assert (c['p_down'], c['p_side'], c['p_up']) == pytest.approx((0.333, 0.334, 0.333))
    assert c['arrow'] == 'flat' and c['basis'] is None and c['calm'] is None


def test_the_three_always_add_to_one(rows):
    for series in ({}, series_for_1h_drop(), {'1h': hourly([100.0] * 61)}):
        c = model.card('1h', 60, 75_000, rows, series, NOW)
        assert c['p_down'] + c['p_side'] + c['p_up'] == pytest.approx(1.0)


def test_the_extra_settlement_card_is_answered_from_the_nearest_horizon(rows):
    out = model.outlook(spot=75_000, now=NOW, series={}, rows=rows, extra=[('to settlement · 9.6h', 576)])
    last = out['rows'][-1]
    assert last['label'] == 'to settlement · 9.6h' and last['measured_minutes'] == 720
    assert out['model'] == 'measured-states-v1'
    assert [r['label'] for r in out['rows'][:9]] == ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '24h']


def test_no_table_answers_no_cards():
    assert model.outlook(spot=75_000, now=NOW, series={}, rows={})['rows'] == []
