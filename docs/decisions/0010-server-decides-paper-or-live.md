# 0010 — The server decides paper or live, and will not flip with a position open

**Status:** accepted · **Since:** September 2026

## Decision

[service.ts](../../app/server/src/trading/service.ts) decides the mode: the
saved `mode` setting if there is one, else live whenever credentials exist and
`DELTA_LIVE_TRADING` is not `0` / `false`. `DELTA_LIVE_TRADING=0` locks the
desk on paper; with no credentials it is paper regardless. The browser asks and
the server answers, and a flip is refused (409, through `refuse()`) while a
position is open.

A page that could put itself into live mode by setting a flag in its own
state is a page that can do it by accident. The mode is on screen at all
times, and every Telegram message from a paper trade says PAPER first.

**Reference:** [environment.md](../reference/environment.md).
