import { useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { deleteStrategy, getStrategies, setScheduler, setStrategyEnabled } from '@/api/strategy';
import type { Strategy, StrategyStatus } from '@/types/strategy';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StrategyForm } from '@/components/strategy/StrategyForm';
import { usePoll } from '@/hooks/usePoll';
import { clock, stamp } from '@/lib/format';
import { describeDays, describePremium } from '@/lib/strategy-preview';
import { cn } from '@/lib/utils';

/**
 * The strategies, what is armed, and when each one next runs.
 *
 * Two switches, deliberately separate. A strategy's own switch says "this rule
 * is one I want"; the scheduler's master switch says "and the desk may act on
 * it without asking". Arming a rule and arming the desk are different
 * decisions, and collapsing them into one toggle is how a config saved in the
 * evening surprises somebody at 05:30.
 */

/** The whole rule in one line, so a strategy can be checked without opening it. */
function summarise(s: Strategy): string {
  const c = s.config;
  const parts = [
    c.legs === 'both' ? 'CE + PE' : c.legs,
    describePremium(c).split(' — ')[0]!,
    `${c.lots} lot${c.lots === 1 ? '' : 's'}`,
    `${c.entryTime}→${c.exitTime}`,
    c.entryPrice === 'offer'
      ? `sell at offer${c.crossAfterSec ? `, market after ${c.crossAfterSec}s` : ', wait'}`
      : `sell at ${c.entryPrice}`,
    c.takeProfitPct > 0 ? `target ${Math.round(c.takeProfitPct * 100)}%` : 'hold to expiry',
  ];
  if (c.stopLossPct > 0) parts.push(`stop ${Math.round(c.stopLossPct * 100)}%`);
  if (c.probGate !== null) parts.push(`min safety ${Math.round(c.probGate * 1000) / 10}%`);
  if (c.doubleWhenOneSided) parts.push('double if one side');
  return parts.join(' · ');
}

export function StrategyPanel() {
  const { data, refresh } = usePoll<StrategyStatus>(getStrategies, 5_000);
  const [editing, setEditing] = useState<Strategy | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Deleting needs a second tap: a strategy is an evening's work, and a phone invites mis-taps.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setFailed(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!data) return null;
  const armed = data.strategies.filter((s) => s.enabled).length;

  return (
    <div className="grid gap-3">
      <Card>
        <CardTitle
          right={
            <span className={cn('text-[11px] font-semibold', data.mode === 'live' ? 'text-[var(--down)]' : 'text-[var(--warn)]')}>
              {data.mode === 'live' ? 'LIVE' : 'PAPER'}
            </span>
          }
        >
          Auto-trading
        </CardTitle>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="m-0 text-[13px] text-foreground">
              {/*
                Never claim an effect the server cannot have. This card read
                "may place orders" for a day while no runner existed, so a
                switch was turned on, nothing happened at 05:30, and the screen
                offered no explanation.
              */}
              {data.runnerInstalled === false
                ? 'Not installed on this server — nothing will run.'
                : data.schedulerOn
                  ? `On — ${armed} strateg${armed === 1 ? 'y' : 'ies'} will place orders automatically.`
                  : 'Off — nothing runs automatically.'}
            </p>
            <p className="m-0 mt-0.5 text-[11.5px] text-muted-foreground">
              Today is {data.today} IST. Each strategy enters at most once a day.
            </p>
          </div>
          <Button
            variant={data.schedulerOn ? 'outline' : 'default'}
            className="h-9"
            disabled={busy === 'sched'}
            onClick={() => void act('sched', () => setScheduler(!data.schedulerOn))}
          >
            {busy === 'sched' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {data.schedulerOn ? 'Turn off' : 'Turn on'}
          </Button>
        </div>

        {data.schedulerOn && data.mode === 'live' && (
          <p className="m-0 mt-2 text-[11.5px] font-medium text-[var(--warn)]">
            Live mode: the desk will place real orders on this schedule without asking.
          </p>
        )}
        {failed && <p className="m-0 mt-2 text-[12px] text-[var(--down)]">{failed}</p>}
      </Card>

      <Card>
        <CardTitle
          right={
            <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setFormOpen(true); }}>
              <Plus className="h-3 w-3" /> New
            </Button>
          }
        >
          Strategies
        </CardTitle>

        <div className="grid gap-2">
          {data.strategies.map((s) => (
            <div
              key={s.id}
              className={cn('rounded-lg border px-2.5 py-2',
                s.enabled ? 'border-[var(--up)]' : 'border-[var(--line)]')}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13.5px] font-semibold text-foreground">{s.name}</span>
                  <span className={cn('text-[11px]', s.enabled ? 'text-[var(--up)]' : 'text-[var(--dim)]')}>
                    {s.enabled ? 'on' : 'off'}
                  </span>
                  {s.ranToday && <span className="text-[11px] text-muted-foreground">ran today</span>}
                </div>
                <div className="flex w-full flex-none gap-1.5 sm:w-auto">
                  <Button
                    size="sm"
                    className="h-8"
                    variant={s.enabled ? 'outline' : 'default'}
                    disabled={busy === s.id}
                    onClick={() => void act(s.id, () => setStrategyEnabled(s.id, !s.enabled))}
                  >
                    {busy === s.id && <Loader2 className="h-3 w-3 animate-spin" />}
                    {s.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8"
                          onClick={() => { setEditing(s); setFormOpen(true); }}>
                    <Pencil className="h-3 w-3" /> Edit
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    className={cn('h-8', confirmDelete === s.id && 'text-[var(--down)]')}
                    aria-label={confirmDelete === s.id ? 'Confirm delete' : `Delete ${s.name}`}
                    disabled={busy === `del-${s.id}`}
                    onClick={() => {
                      if (confirmDelete !== s.id) {
                        setConfirmDelete(s.id);
                        setTimeout(() => setConfirmDelete((cur) => (cur === s.id ? null : cur)), 4_000);
                        return;
                      }
                      setConfirmDelete(null);
                      void act(`del-${s.id}`, () => deleteStrategy(s.id));
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                    {confirmDelete === s.id && 'Tap again to delete'}
                  </Button>
                </div>
              </div>

              <p className="m-0 mt-1 text-[11.5px] leading-snug text-muted-foreground">
                {summarise(s)}
              </p>
              <p className="m-0 mt-0.5 text-[11.5px] text-[var(--dim)]">
                {describeDays(s.config.weekdays)}
                {' · '}
                {/* The server's own words for why it is not entering this second. */}
                {s.status}
                {s.nextEntryAt && ` · next ${stamp(s.nextEntryAt)}`}
              </p>
            </div>
          ))}
        </div>
      </Card>

      {data.runs.length > 0 && (
        <Card>
          <CardTitle>Recent runs</CardTitle>
          {/*
            What each day actually did, in the server's own words.
            This panel showed only "placed" and a time, which answers the least
            interesting question about a day. The row already carried the legs,
            the sizes and the prices -- or the reason nothing was sold -- and it
            was simply not being printed.
          */}
          <div className="grid gap-2">
            {data.runs.slice(0, 15).map((r) => {
              const name = data.strategies.find((s) => s.id === r.strategyId)?.name ?? r.strategyId;
              const tone = r.status === 'placed' ? 'up'
                : r.status === 'failed' ? 'down' : 'dim';
              return (
                <div key={r.id} className="rounded-lg border border-[var(--line)] px-2.5 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="flex items-baseline gap-2">
                      <span className="text-[12.5px] font-medium text-foreground">{name}</span>
                      <span className="text-[11.5px] text-muted-foreground">{r.runDate}</span>
                    </span>
                    <span className="flex items-baseline gap-2">
                      <span className={cn('text-[11.5px] font-medium',
                        tone === 'up' ? 'text-[var(--up)]'
                          : tone === 'down' ? 'text-[var(--down)]' : 'text-[var(--dim)]')}>
                        {r.status === 'placed' ? 'traded'
                          : r.status === 'refused' ? 'stood aside'
                            : r.status === 'failed' ? 'failed' : 'skipped'}
                      </span>
                      <span className="text-[11.5px] tabular-nums text-[var(--dim)]">{clock(r.at)}</span>
                    </span>
                  </div>
                  {/* The legs and prices, or the reason there were none. */}
                  <p className="m-0 mt-1 text-[11.5px] leading-snug text-muted-foreground">
                    {r.detail}
                  </p>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <StrategyForm
        // Remounts when the target changes, so the form never opens holding the
        // previous strategy's numbers.
        key={editing?.id ?? 'new'}
        editing={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={refresh}
        balanceUsd={data.balanceUsd}
        spot={data.spot}
      />
    </div>
  );
}
