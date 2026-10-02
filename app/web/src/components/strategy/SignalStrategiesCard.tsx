import { useState } from 'react';
import { Bot, Loader2, Pencil, Plus } from 'lucide-react';
import { getStrategies, saveStrategy, setStrategyEnabled } from '@/api/strategy';
import type { SignalRunStatus, Strategy, StrategyStatus } from '@/types/strategy';
import { usePoll } from '@/hooks/usePoll';
import { Button } from '@/components/ui/button';
import { SignalStrategyForm } from '@/components/strategy/SignalStrategyForm';
import { LogTable } from '@/components/strategy/LogTable';
import { describeStrike, signalTargetLabel } from '@/lib/strategy-preview';
import { stamp } from '@/lib/format';
import { time12 } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * The signal strategies, on the Live screen beside the methods that make the
 * signals: each one's switch, its live-orders switch, what it is set to, and
 * what the last signals did. New and Edit open the same form as the Strategy
 * tab, already on signals -- one strategy, two places to reach it.
 */

const OUTCOME: Record<SignalRunStatus, string> = {
  placed: 'sold', 'would-place': 'would sell', refused: 'stood aside', skipped: 'skipped', failed: 'failed', claimed: 'taking…',
};

/** One line: the methods and way, the leg rule, the strike, lots, exits. */
export function signalLine(s: Strategy): string {
  const c = s.config;
  const r = c.signal;
  if (!r) return '';
  return [
    `${r.methods.length} method${r.methods.length === 1 ? '' : 's'} ${r.mode === 'mtf' ? 'with the chain' : `on ${r.tf}`}`,
    'BUY → PE · SELL → CE',
    describeStrike(c).split(' — ')[0]!,
    `${c.lots} lot${c.lots === 1 ? '' : 's'}`,
    `perp SL / ${signalTargetLabel(r.target)}`,
    `max ${r.maxOpen} open`,
    `${time12(c.entryTime)} → ${time12(c.exitTime)}`,
  ].join(' · ');
}

export function SignalStrategiesCard({ onOpenStrategyTab }: { onOpenStrategyTab?: () => void }) {
  const { data, refresh } = usePoll<StrategyStatus>(getStrategies, 5_000);
  const [editing, setEditing] = useState<Strategy | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Real orders need a second tap: a switch that sends money to the exchange should not flip on a brush.
  const [confirmLive, setConfirmLive] = useState<string | null>(null);

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
  const setLive = (s: Strategy, on: boolean) => {
    if (on && confirmLive !== s.id) {
      setConfirmLive(s.id);
      setTimeout(() => setConfirmLive((cur) => (cur === s.id ? null : cur)), 4_000);
      return;
    }
    setConfirmLive(null);
    void act(`live-${s.id}`, () => saveStrategy({ id: s.id, name: s.name, config: { ...s.config, liveOrders: on } }));
  };

  const mine = data?.strategies.filter((s) => s.config.trigger === 'signal') ?? [];
  const ids = new Set(mine.map((s) => s.id));
  const runs = (data?.signalRuns ?? []).filter((r) => ids.has(r.strategyId));

  return (
    <section className="live-signal-strategies" aria-label="Signal strategies">
      <div className="desk-section-header">
        <div className="desk-section-title-wrap">
          <div className="desk-section-icon" style={{ background: 'rgba(250, 204, 21, 0.12)', color: '#facc15' }}>
            <Bot size={18} />
          </div>
          <div>
            <h2 className="desk-section-title">Signal Strategies</h2>
            <span className="desk-section-subtitle">The methods&apos; signals as options · BUY sells PE · SELL sells CE · SL / TGT on the BTC perp</span>
          </div>
        </div>
        <div className="desk-section-badges">
          {data && (
            <span className="desk-badge-pill"
                  style={data.schedulerOn
                    ? { background: 'rgba(34, 197, 94, 0.12)', color: '#22c55e', border: '1px solid rgba(34, 197, 94, 0.3)' }
                    : { background: 'rgba(255, 255, 255, 0.05)', color: '#94a3b8', border: '1px solid #1e293b' }}>
              Auto-trading {data.schedulerOn ? 'on' : 'off'}
            </span>
          )}
          {data && (
            <span className="desk-badge-pill"
                  style={data.mode === 'live'
                    ? { background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)' }
                    : { background: 'rgba(250, 204, 21, 0.1)', color: '#facc15', border: '1px solid rgba(250, 204, 21, 0.3)' }}>
              {data.mode === 'live' ? 'LIVE' : 'PAPER'}
            </span>
          )}
          <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus className="h-3.5 w-3.5" /> New signal strategy
          </Button>
        </div>
      </div>

      {data && !data.schedulerOn && mine.some((s) => s.enabled) && (
        <p role="note" className="m-0 mb-2 text-[12px] text-[var(--warn)]">
          Auto-trading is off, so no signal is taken.{' '}
          {onOpenStrategyTab && (
            <button type="button" onClick={onOpenStrategyTab}
                    className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2">
              Turn it on on the Strategy tab
            </button>
          )}
        </p>
      )}
      {failed && <p role="alert" className="m-0 mb-2 text-[12px] text-[var(--down)]">{failed}</p>}

      {data && mine.length === 0 && (
        <p className="m-0 rounded-lg border border-dashed border-[var(--line)] px-3 py-3 text-[12.5px] text-muted-foreground">
          No signal strategy yet. <b className="text-foreground">New signal strategy</b> picks the methods, the strike and the lots;
          each signal is then sold as one option, with its SL and TGT on the BTC perp. Live orders start off.
        </p>
      )}

      <div className="grid gap-2">
        {mine.map((s) => {
          const live = Boolean(s.config.liveOrders);
          return (
            <div key={s.id} className={cn('rounded-lg border px-2.5 py-2', s.enabled ? 'border-[var(--up)]' : 'border-[var(--line)]')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13.5px] font-semibold text-foreground">{s.name}</span>
                  <span className={cn('text-[11px]', s.enabled ? 'text-[var(--up)]' : 'text-[var(--dim)]')}>{s.enabled ? 'on' : 'off'}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" className="h-8" variant={s.enabled ? 'outline' : 'default'} disabled={busy === s.id}
                          onClick={() => void act(s.id, () => setStrategyEnabled(s.id, !s.enabled))}>
                    {busy === s.id && <Loader2 className="h-3 w-3 animate-spin" />}
                    {s.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn('h-8', (live || confirmLive === s.id) && 'border-[var(--down)] text-[var(--down)]')}
                    role="switch"
                    aria-checked={live}
                    aria-label={`Live orders for ${s.name}`}
                    disabled={busy === `live-${s.id}`}
                    onClick={() => setLive(s, !live)}
                  >
                    {busy === `live-${s.id}` && <Loader2 className="h-3 w-3 animate-spin" />}
                    {confirmLive === s.id ? 'Tap again: real orders' : live ? 'Live orders ON' : 'Live orders off'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => { setEditing(s); setFormOpen(true); }}>
                    <Pencil className="h-3 w-3" /> Edit
                  </Button>
                </div>
              </div>
              <p className="m-0 mt-1 text-[11.5px] leading-snug text-muted-foreground">{signalLine(s)}</p>
              <p className="m-0 mt-0.5 text-[11.5px] text-[var(--dim)]">
                {s.status}
                {!live && ' · writes down what it would sell, sends nothing'}
              </p>
            </div>
          );
        })}
      </div>

      {runs.length > 0 && (
        <div className="mt-2">
          <LogTable
            label="signals taken"
            extraHead="Signal"
            rows={runs.map((r) => ({
              id: r.id,
              at: stamp(r.at),
              who: mine.find((s) => s.id === r.strategyId)?.name ?? r.strategyId,
              extra: `${r.dir === 1 ? 'BUY → PE' : 'SELL → CE'} · ${r.mode === 'mtf' ? 'chain' : r.tf}`,
              outcome: OUTCOME[r.status],
              tone: r.status === 'placed' ? 'ok' as const : r.status === 'failed' ? 'bad' as const : 'quiet' as const,
              detail: r.detail,
            }))}
          />
        </div>
      )}

      {data && (
        <SignalStrategyForm
          key={editing?.id ?? 'new-signal'}
          editing={editing}
          open={formOpen}
          onOpenChange={setFormOpen}
          onSaved={refresh}
          balanceUsd={data.balanceUsd}
          spot={data.spot}
        />
      )}
    </section>
  );
}
