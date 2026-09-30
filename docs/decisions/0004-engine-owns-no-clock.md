# 0004 — The trading engine owns no clock

**Status:** accepted · **Since:** September 2026

## Decision

Time arrives as `now()`, work arrives as `poll()`. Nothing in
[engine.ts](../../app/server/src/trading/engine.ts) starts a timer. That is
why the order matrix -- races, disconnects, restart recovery -- runs in under
a second, deterministically.

Concurrency is one promise-chain mutex per trade:

```ts
private withTrade<T>(tradeId: string, fn: () => Promise<T>): Promise<T> {
  const previous = this.queue.get(tradeId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  this.queue.set(tradeId, next.then(() => {}, () => {}));
  return next;
}
```

Public methods take the queue; `*Inner` methods assume they are already inside
it. Mixing those up is how the poll loop once raced a screen action into six
duplicate take-profits.

## Consequences

The service and the strategy runner own the timers
([service.ts](../../app/server/src/trading/service.ts),
[runner.ts](../../app/server/src/strategy/runner.ts)). The engine matrix runs
on `MemoryTradeStore`, a Map behind the same async interface as the real store.
