"""
The analytics service: display-only models for the desk's screens.

Internal only. It has no host port, no credentials and no way to reach an
order: the Node API calls it, and shows its own figures when it cannot. The
OpenAPI pages are switched off so nothing about it is advertised.
"""
from __future__ import annotations

import time
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, model_validator

from . import outlook as model
from .db import open_states

app = FastAPI(title='btc-desk analytics', docs_url=None, redoc_url=None, openapi_url=None)
states = open_states()

Tf = Literal['5m', '15m', '1h', '4h', '1d']


class Bars(BaseModel):
    """Parallel arrays: bar open time (epoch seconds) and close. Compact, and cheap to validate."""
    t: list[int] = Field(max_length=2000)
    c: list[float] = Field(max_length=2000)

    @model_validator(mode='after')
    def same_length(self):
        if len(self.t) != len(self.c):
            raise ValueError('t and c must be the same length')
        return self


class Extra(BaseModel):
    label: str = Field(min_length=1, max_length=40)
    minutes: float = Field(gt=0, le=10_080)


class ChainIn(BaseModel):
    """The raw board, never a bucket: the service labels it with the research's own functions."""
    hours_left: float = Field(gt=0, le=720)
    call_atm: float | None = Field(default=None, ge=0)
    put_atm: float | None = Field(default=None, ge=0)
    # 2, 3 and 4 strikes from the money, in that order; null where a strike has no mark
    put_marks: list[float | None] = Field(default_factory=list, max_length=3)
    call_marks: list[float | None] = Field(default_factory=list, max_length=3)
    put_volume: float | None = Field(default=None, ge=0)
    call_volume: float | None = Field(default=None, ge=0)


class OutlookIn(BaseModel):
    now: int = Field(gt=1_600_000_000)
    spot: float = Field(gt=0)
    series: dict[Tf, Bars]
    extra: list[Extra] = Field(default_factory=list, max_length=4)
    chain: ChainIn | None = None


@app.get('/health')
def health():
    rows = states.rows()
    return {
        'ok': True,
        'outlook_rows': len(rows),
        'chain_rows': len(states.chain()),
        'measured_at': next(iter(rows.values())).measured_at if rows else None,
        'now': int(time.time()),
    }


@app.post('/v1/outlook')
def post_outlook(body: OutlookIn):
    rows = states.rows()
    if not rows:
        # Not measured yet: the Node side shows its own cards, which is the right answer.
        raise HTTPException(status_code=503, detail='outlook_states has not been measured')
    series = {tf: (b.t, b.c) for tf, b in body.series.items()}
    chain = None if body.chain is None else {**body.chain.model_dump(), 'spot': body.spot}
    return model.outlook(
        spot=body.spot, now=body.now, series=series, rows=rows,
        extra=[(e.label, e.minutes) for e in body.extra],
        chain_rows=states.chain(), chain=chain,
    )
