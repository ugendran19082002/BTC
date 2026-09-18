"""
The features both sides of the model are labelled with.

`research/outlook_parity.py` wrote these vectors from a real stretch of the
five-minute tape. The measurement and the live service import the same module,
so they cannot disagree today -- this pins the numbers, so a change to the maths
is a failing test rather than a quiet relabelling of every card.
"""
import json
import os

import pytest

from app.features import ema_series, momentum_bucket, rsi_bucket, rsi_series, stack_bucket

FIX = json.load(open(os.path.join(os.path.dirname(__file__), 'fixtures', 'outlook-parity.json')))
closes = FIX['closes']


def test_ema_matches_the_vectors():
    assert ema_series(closes, 9)[-1] == pytest.approx(FIX['ema9_last'], abs=1e-9)
    assert ema_series(closes, 21)[-1] == pytest.approx(FIX['ema21_last'], abs=1e-9)
    assert ema_series(closes, 50)[-1] == pytest.approx(FIX['ema50_last'], abs=1e-9)
    assert ema_series(closes, 9)[60] == pytest.approx(FIX['ema9_at_60'], abs=1e-9)


def test_ema_is_seeded_with_the_simple_mean_and_undefined_before():
    e = ema_series([1, 2, 3, 4, 5], 3)
    assert e[:2] == [None, None]
    assert e[2] == pytest.approx(2.0)                   # mean of 1, 2, 3
    assert e[3] == pytest.approx(4 * 0.5 + 2.0 * 0.5)   # k = 2 / (3 + 1)


def test_rsi_matches_the_vectors():
    assert rsi_series(closes)[-1] == pytest.approx(FIX['rsi_last'], abs=1e-9)
    assert rsi_series(closes)[60] == pytest.approx(FIX['rsi_at_60'], abs=1e-9)


def test_rsi_is_100_with_no_losses_and_undefined_before_15_bars():
    up = list(range(1, 20))
    r = rsi_series(up)
    assert r[13] is None
    assert r[14] == 100.0


def test_buckets_match_the_vectors():
    assert stack_bucket(FIX['ema9_last'], FIX['ema21_last'], FIX['ema50_last']) == FIX['stack']
    assert rsi_bucket(FIX['rsi_last']) == FIX['rsi_bucket']
    for case in FIX['momentum']:
        move = closes[-1] / closes[-1 - case['bars']] - 1
        assert move == pytest.approx(case['move'], abs=1e-12)
        assert momentum_bucket(move, case['tau']) == case['bucket']


def test_rsi_edges_are_strict():
    # exactly 30 and exactly 70 are neutral, as in the measurement
    assert {k: rsi_bucket(float(k)) for k in FIX['rsi_edges']} == FIX['rsi_edges']
    assert rsi_bucket(30.0) == 'neutral' and rsi_bucket(70.0) == 'neutral'


def test_a_stack_needs_all_three_averages():
    assert stack_bucket(None, 1, 2) is None
    assert stack_bucket(3, 2, 1) == 'rising'
    assert stack_bucket(1, 2, 3) == 'falling'
    assert stack_bucket(2, 3, 1) == 'mixed'
