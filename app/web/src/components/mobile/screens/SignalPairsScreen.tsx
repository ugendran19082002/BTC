import { getMethodReport } from '@/api/entry';
import { getActivity } from '@/api/phone';
import { ruleTfWords } from '@/types/strategy';
import type { EntryMode } from '@/types/entry';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { pct } from '@/lib/format';
import { chosenTfs, pairsOfReport, pickTf, splitPairs, takenBy, timeframesOf, type SignalPair } from '@/lib/method-pairs';
import { cn } from '@/lib/utils';
import { usePhone } from '@/components/mobile/phone-context';
import { Chip, Chips, Empty, Loading, Panel, Segmented, Stat, Stats } from '@/components/mobile/parts';
import { PairList } from '@/components/mobile/PairList';
import { useDayRange } from '@/components/mobile/useDayRange';
import { StrategyPicker, type StrategyOption } from '@/components/mobile/StrategyPicker';
import { describeRange } from '@/components/ui/date-range-picker';

/**
 * Signal history pairs (owner, 6 Oct 2026): the best and the worst pairs of entry method and timeframe again, this
 * time from the signal history -- every signal the methods gave on the days chosen, whether or not the desk
 * placed an order on it -- where P&L's are from the orders actually traded. With the timeframe chain or without it,
 * and with P&L's own date filter. Without the chain there is a row of timeframes under it, to keep one or several
 * ("single select and multiple select"): one at a time by default, a switch beside it for many.
 *
 * Only a signal that became a trade is ranked: one that filled and then closed at its target, its stop or on time.
 * It is graded on the BTC perp, in points from its fill to its exit, with no charges: this is how good the signals
 * were, not what the account made. Read from the desk's Methods report (`/api/entry/report`).
 *
 * The same strategy filter as P&L's (owner, 8 Oct 2026): tick one signal strategy or several and only the signals
 * they take are kept -- their methods, on their timeframes, read their way (`takenBy`). It narrows what is on the
 * screen; the way of reading and the timeframes above it still apply on top.
 */

const WAYS: { key: EntryMode; label: string; spoken: string }[] = [
  { key: 'single', label: 'Without timeframe', spoken: 'Without the timeframe chain' },
  { key: 'mtf', label: 'With timeframe', spoken: 'With the timeframe chain' },
];

const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '');
/** BTC perp points, signed: "+1,240 pts". */
const pts = (n: number) => `${sign(Math.round(n))}${Math.abs(Math.round(n)).toLocaleString('en-US')} pts`;
/** R, signed, to one place: "+8.4R". */
const inR = (n: number) => `${sign(Number(n.toFixed(1)))}${Math.abs(n).toFixed(1)}R`;

export function SignalPairsScreen() {
  const p = usePhone();
  const range = useDayRange('m-sigpairs', p.now);
  const { isToday, from, to, today } = range;
  const [way, setWay] = usePersisted<EntryMode>('m-sigpairs-way', 'single');
  const report = usePoll(() => getMethodReport(null, false, { from, to }), isToday ? 60_000 : 180_000, { deps: [from, to] });

  // The timeframes kept, without the chain: none is all of them. One at a time, or many (the switch beside the row).
  const [picked, setPicked] = usePersisted<string[]>('m-sigpairs-tfs', []);
  const [how, setHow] = usePersisted<'one' | 'many'>('m-sigpairs-pick', 'one');
  const tfs = report.data ? timeframesOf(report.data) : [];
  const kept = report.data && way === 'single' ? chosenTfs(report.data, picked) : [];
  // The signal strategies to choose from, and the ones kept: none is every signal, as it was.
  const activity = usePoll(() => getActivity(p.accountParam), 300_000, { deps: [p.accountParam] });
  const [strategies, setStrategies] = usePersisted<string[]>('m-sigpairs-strategies', []);
  const signalOnes = (activity.data?.strategies ?? []).filter((s) => s.config.trigger === 'signal' && s.config.signal);
  const options: StrategyOption[] = signalOnes.map((s) => {
    const rule = s.config.signal!;
    return { key: s.id, name: s.name, note: `${ruleTfWords(rule)} · ${rule.methods.length} method${rule.methods.length === 1 ? '' : 's'}${s.enabled ? '' : ' · off'}` };
  });
  const chosen = signalOnes.filter((s) => strategies.includes(s.id));
  const rules = chosen.map((s) => s.config.signal!);
  const read = report.data ? pairsOfReport(report.data, way, kept, rules.length ? takenBy(rules, way) : undefined) : null;
  // The strategies chosen are all read the other way: nothing of theirs can be on this side of the switch.
  const otherWay = rules.length > 0 && !rules.some((r) => r.mode === way);
  const ofChosen = chosen.length === 0 ? '' : chosen.length === 1 ? ` · ${chosen[0]!.name}` : ` · ${chosen.length} strategies`;
  const split = read ? splitPairs(read.pairs) : null;
  const all = read?.pairs ?? [];
  const wins = all.reduce((n, x) => n + x.wins, 0);
  const losses = all.reduce((n, x) => n + x.losses, 0);
  const net = all.reduce((n, x) => n + x.net, 0);
  const netR = all.reduce((n, x) => n + x.netR, 0);
  const wonPts = all.reduce((n, x) => n + x.wonPts, 0);
  const lostPts = all.reduce((n, x) => n + x.lostPts, 0);
  const inRange = isToday ? 'today' : 'in this range';
  const wayWords = way === 'mtf' ? 'with the timeframe chain' : `without the timeframe chain${kept.length ? ` on ${kept.join(', ')}` : ''}`;
  const amount = (g: SignalPair) => pts(g.net);
  const note = (g: SignalPair) => inR(g.netR);
  // What its winners made and its losers gave back, under the two ends of the row's bar (owner, 6 Oct 2026).
  const ends = (g: SignalPair) => ({ won: pts(g.wonPts), lost: pts(-g.lostPts) });

  return (
    <>
      {range.bar}
      <StrategyPicker options={options} picked={strategies} onChange={setStrategies} />
      <Segmented label="Way of reading" value={way} options={WAYS} onChange={setWay} />
      {way === 'single' && tfs.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
            <span className="text-[12.5px] text-muted-foreground">Time frame: <span className="text-foreground">{kept.length ? kept.join(', ') : 'all'}</span></span>
            <span role="group" aria-label="Pick one time frame or many" className="flex shrink-0 rounded-full bg-muted p-0.5">
              {(['one', 'many'] as const).map((h) => (
                <button
                  key={h} type="button" aria-pressed={how === h}
                  // Back to one at a time with several kept: the first of them stays.
                  onClick={() => { setHow(h); if (h === 'one' && kept.length > 1) setPicked(kept.slice(0, 1)); }}
                  className={cn('h-9 rounded-full border-0 px-3 font-[inherit] text-[12.5px] font-medium', how === h ? 'bg-[var(--panel-3)] text-foreground' : 'bg-transparent text-muted-foreground')}
                >
                  {h === 'one' ? 'One' : 'Many'}
                </button>
              ))}
            </span>
          </div>
          <Chips label="Time frame">
            <Chip on={kept.length === 0} onClick={() => setPicked([])}>All</Chip>
            {tfs.map((t) => <Chip key={t} on={kept.includes(t)} onClick={() => setPicked(pickTf(kept, t, how))}>{t}</Chip>)}
          </Chips>
        </div>
      )}

      <Panel>
        <span className="flex items-baseline justify-between gap-2 text-[13px] text-muted-foreground">
          <span>Signals {isToday ? 'today' : describeRange({ from, to }, today)}, {wayWords}{ofChosen}</span>
          {range.isCustom && (
            <button type="button" onClick={range.pick} className="shrink-0 border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">
              Change
            </button>
          )}
        </span>
        {!read ? <Loading error={report.error} what="the signal history" /> : (
          <>
            <div className={`mt-0.5 text-[26px] font-semibold tabular-nums ${net > 0 ? 'text-[var(--up)]' : net < 0 ? 'text-[var(--down)]' : ''}`}>
              {pts(net)} <span className="text-[14px] font-medium text-muted-foreground">{inR(netR)}</span>
            </div>
            <div className="mt-2">
              <Stats cols={3}>
                <Stat label="Signals">{read.signals.toLocaleString('en-US')}</Stat>
                <Stat label="Trades">{(split?.trades ?? 0).toLocaleString('en-US')}</Stat>
                <Stat label="Win rate">{split && split.trades > 0 ? pct(wins / split.trades, 0) : '—'}</Stat>
                <Stat label="Won" tone={wins ? 'up' : undefined}>{wins}</Stat>
                <Stat label="Lost" tone={losses ? 'down' : undefined}>{losses}</Stat>
                <Stat label="Pairs">{all.length}</Stat>
                <Stat label="Won pts" tone={wonPts ? 'up' : undefined}>{pts(wonPts).replace(' pts', '')}</Stat>
                <Stat label="Loss pts" tone={lostPts ? 'down' : undefined}>{pts(-lostPts).replace(' pts', '')}</Stat>
                <Stat label="Profit factor">{lostPts > 0 ? (wonPts / lostPts).toFixed(2) : wonPts > 0 ? 'no loss' : '—'}</Stat>
              </Stats>
            </div>
          </>
        )}
      </Panel>

      {split && split.trades > 0 ? (
        <>
          <PairList title="Best pairs" tone="up" pairs={split.best} amount={amount} note={note} ends={ends} empty={`No method and time frame is in profit ${inRange}.`} />
          <PairList title="Worst pairs" tone="down" pairs={split.worst} amount={amount} note={note} ends={ends} empty={`No method and time frame is in loss ${inRange}.`} />
        </>
      ) : read ? (
        <Panel>
          <Empty>
            {otherWay
              ? `${chosen.length === 1 ? `${chosen[0]!.name} takes` : 'The strategies chosen take'} signals ${way === 'mtf' ? 'without' : 'with'} the timeframe chain only. Switch the way of reading above, or choose another strategy.`
              : `No signal${chosen.length ? ` ${chosen.length === 1 ? `${chosen[0]!.name} takes` : 'the strategies chosen take'}` : ''} became a trade ${inRange}, ${wayWords}.`}
          </Empty>
        </Panel>
      ) : null}

      <p className="m-0 px-1 text-[12px] text-muted-foreground">
        From the signal history, whether or not an order was placed on the signal. Only signals that became a trade are ranked: filled, then closed at the
        target, the stop or on time. One still waiting, or never filled, is counted under Signals alone. Points are on the BTC perp from the fill to the exit,
        R is points over the risk to the stop, and there are no charges. What the orders really made is on P&L.
      </p>
    </>
  );
}
