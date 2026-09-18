"""The HTTP contract the Node API relies on."""
import pytest
from fastapi.testclient import TestClient

from app import main
from app.db import States

NOW = 1_789_600_000


@pytest.fixture
def client(db_path, monkeypatch):
    monkeypatch.setattr(main, 'states', States(db_path))
    return TestClient(main.app)


def test_health_says_what_is_loaded(client):
    r = client.get('/health')
    assert r.status_code == 200
    assert r.json()['ok'] is True and r.json()['outlook_rows'] > 0


def test_outlook_happy_path(client):
    body = {'now': NOW, 'spot': 75_000, 'series': {'1h': {'t': [NOW - 7200, NOW - 3600], 'c': [100.0, 99.0]}},
            'extra': [{'label': 'to settlement · 9.6h', 'minutes': 576}]}
    r = client.post('/v1/outlook', json=body)
    assert r.status_code == 200
    rows = r.json()['rows']
    assert len(rows) == 10 and rows[-1]['label'] == 'to settlement · 9.6h'


def test_bad_input_is_refused_not_guessed(client):
    assert client.post('/v1/outlook', json={'now': NOW, 'spot': -1, 'series': {}}).status_code == 422
    assert client.post('/v1/outlook', json={'now': NOW, 'spot': 1, 'series': {'1h': {'t': [1, 2], 'c': [1.0]}}}).status_code == 422
    assert client.post('/v1/outlook', json={'now': NOW, 'spot': 1, 'series': {'7m': {'t': [], 'c': []}}}).status_code == 422


def test_no_measured_table_is_a_503_so_node_shows_its_own_cards(tmp_path, monkeypatch):
    monkeypatch.setattr(main, 'states', States(str(tmp_path / 'missing.db')))
    r = TestClient(main.app).post('/v1/outlook', json={'now': NOW, 'spot': 1, 'series': {}})
    assert r.status_code == 503


def test_no_api_docs_are_published(client):
    for path in ('/docs', '/redoc', '/openapi.json'):
        assert client.get(path).status_code == 404


def test_the_board_is_accepted_and_answered_with_context(client):
    body = {'now': NOW, 'spot': 76_000, 'series': {},
            'extra': [{'label': 'to settlement · 12h', 'minutes': 720}],
            'chain': {'hours_left': 12, 'call_atm': 500, 'put_atm': 488, 'put_marks': [200, 130, 80],
                      'call_marks': [198, 128, None], 'put_volume': 10_000, 'call_volume': 10_500}}
    r = client.post('/v1/outlook', json=body)
    assert r.status_code == 200
    out = r.json()
    assert out['rows'][-1]['calm'] == 'livelier'
    ctx = {c['feature']: c for c in out['context']}
    assert ctx['skew']['value'] is None and ctx['skew']['bucket'] is None      # a missing mark is no reading
    assert client.get('/health').json()['chain_rows'] == 10


def test_a_board_out_of_range_is_refused(client):
    base = {'now': NOW, 'spot': 76_000, 'series': {}}
    assert client.post('/v1/outlook', json={**base, 'chain': {'hours_left': 0}}).status_code == 422
    assert client.post('/v1/outlook', json={**base, 'chain': {'hours_left': 5, 'put_marks': [1, 2, 3, 4]}}).status_code == 422
