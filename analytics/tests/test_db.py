"""Where the measured tables are read from."""
from app import db


def test_the_services_own_database_comes_first(monkeypatch):
    monkeypatch.setenv('ANALYTICS_DB', '/srv/data/analytics.db')
    monkeypatch.setenv('CHAIN_DB', '/srv/data/chain.db')
    assert db.default_path() == '/srv/data/analytics.db'


def test_chain_db_then_the_repo_copy_for_local_work(monkeypatch):
    monkeypatch.delenv('ANALYTICS_DB', raising=False)
    monkeypatch.setenv('CHAIN_DB', '/tmp/x/chain.db')
    assert db.default_path() == '/tmp/x/chain.db'
    monkeypatch.delenv('CHAIN_DB', raising=False)
    assert db.default_path().endswith('chain.db')


def test_a_missing_database_is_no_rows_not_an_error(tmp_path):
    assert db.States(str(tmp_path / 'absent.db')).rows() == {}
