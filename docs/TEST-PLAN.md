# Test plan — a strategy and its orders, step by step

Every step of a strategy's life, from the form to the database, and the test
that proves it. Run them all with `npm test` in `app/server` (needs
`deploy/test-db.sh up`) and `npx vitest run` in `app/web`; `deploy.sh` runs both
before it builds.

**The end-to-end scenario** is `app/server/test/e2e/strategy-lifecycle.test.ts`:
one strategy through the real HTTP API, the real engine on the service's paper
exchange, and the real database, in order. The rows marked **E2E n** are its
steps. The others are the unit and component tests behind each part.

## 1. Build the strategy (UI)

| # | Step | What must hold | Test |
|---|---|---|---|
| 1.1 | Name, legs | A name that says CE on a put strategy is warned about | `web: StrategyForm.test` "warnings…", `strategy-checks.test` |
| 1.2 | Entry / exit time | Exit before the 5:30 PM settlement; overnight measured forward | `web: StrategyForm.test` "times on a clock", `strategy-rules.test` |
| 1.3 | Premium rule + fallback | At most $20, else the last strike ≤ $50; fallback above the cap | `web: StrategyForm.test` "premium fallback" |
| 1.4 | Target / stop: %, Fixed, Price | Target ≤ 99%; stop may pass 100%; Price shows the balance against the entry | `web: StrategyForm.test` "exits…", "exits as a price…" |
| 1.5 | Time steps | After entry, before exit, in order; a repeat is warned about; Fill builds the ladder | `web: StrategyForm.test` "exits on a timetable", `strategy-exits.test` |
| 1.6 | The list | Two strategies on one leg at one minute are warned about; an armed one counts down to entry | `web: StrategyPanel.test`, `EntryCountdown.test` |

## 2. Save and arm it (API → DB)

| # | Step | What must hold | Test |
|---|---|---|---|
| 2.1 | A bad config | 422 with every problem in words; nothing written | **E2E 1**, `server: exit-steps.test` "validateConfig…" |
| 2.2 | A good config | Stored as typed; retired settings dropped; no stale "my price" | **E2E 2**, `server: store.test` "retired settings…" |
| 2.3 | Listed | Off, with its status and next entry | **E2E 3** |
| 2.4 | Switched on | `enabled` in the row | **E2E 4** |
| 2.5 | Schema | Every migration applied once, in order; retired keys stripped | `server: db/migrate.test`, `store.test` |

## 3. Enter (runner → engine → exchange → DB)

| # | Step | What must hold | Test |
|---|---|---|---|
| 3.1 | Due | Due at its minute, inside the grace window, once a day | `server: schedule.test`, `duplication.test` |
| 3.2 | Claim the day | Before any order; a second claim loses | **E2E 5**, `duplication.test` |
| 3.3 | Pick the strike | Premium rule, fallback only when the number finds nothing | `server: select.test` |
| 3.4 | Place | Exits in force now, each in its own mode; a Price stop is the level | **E2E 6**, `exit-steps.test` "UG-PE as saved…" |
| 3.5 | Refuse a wrong-side exit | A stop at/under the entry never reaches the book | **E2E 13**, `exits-follow-fill.test` |
| 3.6 | Fill + protect | Target and stop on the book; `entry_submitted → fill → protection_placed` journalled | **E2E 7**, `trading/orders.test` (81-case matrix) |

## 4. Hold (the day)

| # | Step | What must hold | Test |
|---|---|---|---|
| 4.1 | The API view | Plan, book and how each exit was asked for | **E2E 8** |
| 4.2 | Time steps | Each stage once, when it begins; only the leg that changed | **E2E 9**, `exit-steps.test` "StrategyExitStepper" |
| 4.3 | Fill elsewhere | % / Fixed follow the fill; a Price stays and its balance is re-measured | `exits-follow-fill.test` |
| 4.4 | Edit by hand | Opens in the mode it was set in; a price is pinned; wrong side refused, nothing moves | **E2E 11**, `web: EditExitsSheet.test` |
| 4.5 | Edit the strategy while open | Never closes the position (22 Sep) | **E2E 10**, `schedule.test` "UG-PE filled at 22:25:17…" |

## 5. Exit and record

| # | Step | What must hold | Test |
|---|---|---|---|
| 5.1 | Exit time | The position's own exit time; closed at the market; siblings cancelled | **E2E 12** |
| 5.2 | Record | The run's row says what was closed; nothing left resting | **E2E 12** |
| 5.3 | Target / stop fills | At its price or better; the other side cancelled | `trading/orders.test`, `exit-steps.test` real-time |
| 5.4 | Delete | The strategy goes; its runs and trades stay | **E2E 14** |

## 6. Screens on a phone

Measured with a touch pointer at 360 / 390 / 768 px on every screen: no
sideways scroll, and every control at least 32 px on a touch screen. Rerun with
`npm run test:responsive` against a running app.
