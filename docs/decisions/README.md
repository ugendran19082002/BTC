# Decisions

One page per rule the desk runs on: what was decided, what forced it, and what
it costs. Nearly every one was learned by getting it wrong first, and the
dated incident is linked so the reason can be checked rather than trusted.

Read these before changing anything in `app/server/src/trading/`.

| # | Decision | Since |
|---|---|---|
| [0001](0001-read-the-exchange.md) | Anything labelled as what the exchange is doing is read from the exchange | Sep 2026 |
| [0002](0002-simulator-is-not-the-venue.md) | A simulator is evidence about our logic, never about the venue's | 9 Sep 2026 |
| [0003](0003-position-from-fills.md) | Position is counted from fills, never assumed | Sep 2026 |
| [0004](0004-engine-owns-no-clock.md) | The trading engine owns no clock | Sep 2026 |
| [0005](0005-error-log-only-what-needs-fixing.md) | The error log holds only what needs fixing | Sep 2026 |
| [0006](0006-target-is-a-price-stop-is-an-exit.md) | A target is a resting limit; a stop is an exit, judged here and backstopped at Delta | 10-29 Sep 2026 |
| [0007](0007-feed-age-is-the-newest-source.md) | A feed's age is the age of the newest thing that arrived, from any source | 21 Sep 2026 |
| [0008](0008-one-database-one-schema.md) | One PostgreSQL database, one schema; `chain.db` stays a file | 19 Sep 2026 |
| [0009](0009-append-only-journal.md) | The trade journal is append-only and replayed | Sep 2026 |
| [0010](0010-server-decides-paper-or-live.md) | The server decides paper or live, and will not flip with a position open | Sep 2026 |
| [0011](0011-one-trade-per-contract.md) | Two strategies may hold one contract; each trade keeps its own | 30 Sep 2026 |
| [0012](0012-generated-reference-docs.md) | Reference docs are generated from the code and tested | 30 Sep 2026 |

A new decision gets the next number, the same headings, and a line here. A
decision that is replaced is not deleted: its status says what replaced it.
