# Settings backup — 2 Nov 2026, 19:22 IST

The desk's strategy and account settings as they stood on the evening of 2 Nov 2026, after the day's R&D changes were
put back to the morning's (owner: "before kondu vaa kaalai"), saved at the owner's word ("intha setting backup ... save
pani vachuko"). The full data — every strategy's whole config, every account setting, the groups — is in
[2026-11-02-settings-backup.json](2026-11-02-settings-backup.json); this page is the readable summary. What was tried that
day and why it was put back: [../research/2026-11-rd-profit-and-loss.md](../research/2026-11-rd-profit-and-loss.md).

> Taken before Income was changed the same evening: Income's strategies are now copies of High's with the A7 windows
> (see 2026-10.md). The Income rows below are Income as it was at 19:22.

## Accounts

| | High (1) | Medium (2) | Low (3) | Income (4) |
|---|---|---|---|---|
| At most open (cap) | 165 | 160 | 185 | 185 |
| Most on one strike (% of cap) | 22 | 22 | 22 | 21 |
| Daily loss limit switch | off | off | off | off |
| Momentum guard | off (unset) | off (unset) | off (unset) | {"on":false,"pts":250} |
| Re-entry | `{"sl":{"on":false,"from":"07:00","to":"17:29","entries":2},"tgt":{"on":false,"from":"07:00","to":"10:00","entries":1}}` | `{"sl":{"on":false,"from":"07:00","to":"17:29","entries":1},"tgt":{"on":false,"from":"07:00","to":"10:00","entries":1}}` | `{"sl":{"on":false,"from":"07:00","to":"17:29","entries":1},"tgt":{"on":false,"from":"07:00","to":"10:00","entries":1}}` | `{"sl":{"on":false,"from":"07:00","to":"17:29","entries":1},"tgt":{"on":false,"from":"07:00","to":"10:00","entries":1}}` |
| Fill window (s by tf) | `{"3m":100,"5m":100,"15m":200}` | `{"3m":100,"5m":100,"15m":200}` | `{"3m":100,"5m":100,"15m":200}` | `{"3m":100,"5m":100,"15m":200}` |

Desk-wide: mode `live`, scheduler on, alerts on, expiry `first`, the desk's own cap `28`.

## High (account 1)

Every strategy: entry 07:00–exit 17:29, option SL 250%, min premium $13, live orders on; method update on at 21:00, win 70%, every 14 days on the 14 before, least trades 1, only if better on; last pick 26 Oct 23:13.

| Strategy | Id | No entry | Delta (07:00 → block) | Perp SL min | Methods | Max open | Enabled |
|---|---|---|---|--:|--:|--:|---|
| 3m time | `5m-time-copy` | 15:59–17:29 | 0.11 → 0.09 @ 11:00 | 200 | 57 | 100 | yes |
| 5m time | `15m-time-copy-2` | 15:59–17:29 | 0.11 → 0.09 @ 11:00 | 200 | 64 | 100 | yes |
| 15m time | `15m-30m-1h-no-time-frame-copy` | 15:59–17:29 | 0.12 → 0.1 @ 11:00 | 150 | 53 | 100 | yes |
| all time | `3m-time-copy` | 15:59–17:29 | 0.11 → 0.09 @ 11:00 | 150 | 51 | 100 | yes |
| 30m time | `15m-time-frame-copy` | 15:59–17:29 | 0.11 → 0.09 @ 11:00 | 200 | 49 | 100 | yes |
| 1h time | `30m-time-frame-copy` | 15:59–17:29 | 0.11 → 0.09 @ 11:00 | 250 | 39 | 100 | yes |
| 2h time | `5m-time-copy-2` | 15:59–17:29 | 0.12 → 0.1 @ 11:00 | 250 | 32 | 100 | yes |
| 4h time | `1h-time-frame-copy` | 16:00–17:29 | 0.11 → 0.09 @ 11:00 | 300 | 25 | 100 | yes |

## Medium (account 2)

Every strategy: entry 07:00–exit 17:29, option SL 250%, min premium $13, live orders on; method update on at 21:00, win 80%, every 14 days on the 14 before, least trades 1, only if better on; last pick 27 Oct 08:07.

| Strategy | Id | No entry | Delta (07:00 → block) | Perp SL min | Methods | Max open | Enabled |
|---|---|---|---|--:|--:|--:|---|
| 3m time | `5m-time-copy-medium` | 11:00–11:59, 13:00–17:29 | 0.11 → 0.09 @ 11:00 | 200 | 54 | 100 | yes |
| 5m time | `15m-time-copy-2-medium` | 11:00–11:59, 13:00–17:29 | 0.11 → 0.09 @ 11:00 | 200 | 57 | 100 | yes |
| 15m time | `15m-30m-1h-no-time-frame-copy-medium` | 11:00–11:59, 13:00–17:29 | 0.12 → 0.1 @ 11:00 | 150 | 51 | 100 | yes |
| all time | `3m-time-copy-medium` | 11:00–11:59, 13:00–17:29 | 0.11 → 0.09 @ 11:00 | 150 | 52 | 100 | yes |
| 30m time | `15m-time-frame-copy-medium` | 11:00–11:59, 13:00–17:29 | 0.11 → 0.09 @ 11:00 | 200 | 47 | 100 | yes |
| 1h time | `30m-time-frame-copy-medium` | 11:00–11:59, 13:00–17:29 | 0.11 → 0.09 @ 11:00 | 250 | 35 | 100 | yes |
| 2h time | `5m-time-copy-2-medium` | 11:00–11:59, 13:00–17:29 | 0.12 → 0.1 @ 11:00 | 250 | 30 | 100 | yes |
| 4h time | `1h-time-frame-copy-medium` | 11:00–11:59, 13:00–17:29 | 0.11 → 0.09 @ 11:00 | 300 | 27 | 100 | yes |

## Low (account 3)

Every strategy: entry 07:00–exit 17:29, option SL 250%, min premium $13, live orders on; method update on at 21:00, win 80%, every 14 days on the 14 before, least trades 1, only if better on; last pick 27 Oct 08:07.

| Strategy | Id | No entry | Delta (07:00 → block) | Perp SL min | Methods | Max open | Enabled |
|---|---|---|---|--:|--:|--:|---|
| 3m time | `5m-time-copy-low` | 11:00–17:29 | 0.11 → 0.09 @ 11:00 | 150 | 52 | 100 | yes |
| 5m time | `15m-time-copy-2-low` | 11:00–17:29 | 0.11 → 0.09 @ 11:00 | 150 | 57 | 100 | yes |
| 15m time | `15m-30m-1h-no-time-frame-copy-low` | 11:00–17:29 | 0.12 → 0.1 @ 11:00 | 150 | 49 | 100 | yes |
| all time | `3m-time-copy-low` | 11:00–17:29 | 0.11 → 0.09 @ 11:00 | 150 | 51 | 100 | yes |
| 30m time | `15m-time-frame-copy-low` | 11:00–17:29 | 0.11 → 0.09 @ 11:00 | 200 | 47 | 100 | yes |
| 1h time | `30m-time-frame-copy-low` | 11:00–17:29 | 0.11 → 0.09 @ 11:00 | 250 | 36 | 100 | yes |
| 2h time | `5m-time-copy-2-low` | 11:00–17:29 | 0.12 → 0.1 @ 11:00 | 250 | 29 | 100 | yes |
| 4h time | `1h-time-frame-copy-low` | 11:00–17:29 | 0.11 → 0.09 @ 11:00 | 300 | 26 | 100 | yes |

## Income (account 4)

Every strategy: entry 07:00–exit 17:29, option SL 250%, min premium $13, live orders on; method update on at 21:00, win 80%, every 14 days on the 14 before, least trades 1, only if better on; last pick 27 Oct 08:07.

| Strategy | Id | No entry | Delta (07:00 → block) | Perp SL min | Methods | Max open | Enabled |
|---|---|---|---|--:|--:|--:|---|
| 3m time | `5m-time-copy-income` | 11:00–12:59, 15:59–17:29 | 0.11 → 0.09 @ 11:00 | 150 | 52 | 100 | yes |
| 5m time | `15m-time-copy-2-income` | 11:00–12:59, 15:59–17:29 | 0.11 → 0.09 @ 11:00 | 150 | 57 | 100 | yes |
| 15m time | `15m-30m-1h-no-time-frame-copy-income` | 11:00–12:59, 15:59–17:29 | 0.12 → 0.1 @ 11:00 | 150 | 49 | 100 | yes |
| all time | `3m-time-copy-income` | 11:00–12:59, 15:59–17:29 | 0.11 → 0.09 @ 11:00 | 150 | 51 | 100 | yes |
| 30m time | `15m-time-frame-copy-income` | 11:00–12:59, 15:59–17:29 | 0.11 → 0.09 @ 11:00 | 200 | 47 | 100 | yes |
| 1h time | `30m-time-frame-copy-income` | 11:00–12:59, 15:59–17:29 | 0.11 → 0.09 @ 11:00 | 250 | 36 | 100 | yes |
| 2h time | `5m-time-copy-2-income` | 11:00–12:59, 15:59–17:29 | 0.12 → 0.1 @ 11:00 | 250 | 29 | 100 | yes |
| 4h time | `1h-time-frame-copy-income` | 11:00–12:59, 15:59–17:29 | 0.11 → 0.09 @ 11:00 | 300 | 26 | 100 | yes |

## Putting it back

The JSON holds each strategy's whole `config` by its `id`. To restore: read the live rows, and for each strategy write
its backed-up config in one transaction, guarded on the live row being what was read (so nothing changed meanwhile is
overwritten blind); check every config with `validateConfig` first; rehearse on a copy of the database; afterwards
compare the live rows with the JSON byte for byte. Account settings go back as `settings` rows (`key`, `value`).
The method lists in the JSON are the picks of 26–27 Oct; the next automatic pick replaces them.
