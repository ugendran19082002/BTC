import { getSessionLossOf, type SessionLossView } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import { usePhone } from '@/components/mobile/phone-context';
import { Bar, Panel } from '@/components/mobile/parts';
import { cn } from '@/lib/utils';

/**
 * The session loss limit on the phone's Positions, to read only (owner, 6 Nov 2026: "session loss limit desk update
 * pandra maari iruku and view; phone side position menu la mobile friendly, user friendly view matum"). It is set on the
 * desk's Account card, or the phone's Account screen; here, each account shown: the session now, this session's money
 * so far, a bar of the limit used, and what is left before the account is squared off. On "All accounts", two to a row
 * (owner, 7 Nov 2026: "2 account oru row, 2 column kaatu"): each a small tile -- name and money, the bar, what is left.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const rupees = (n: number) => `₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
const signed = (n: number) => (Math.round(n) === 0 ? '₹0' : `${n > 0 ? '+' : '−'}${rupees(n)}`);
/** IST "HH:MM" of a moment. */
const istClock = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(11, 16);

/** The next session to start after `now` today, or the first one tomorrow. */
export function nextSession(v: Pick<SessionLossView, 'setting'>, now: number): string | null {
  const starts = v.setting.sessions.map((s) => s.from).filter((t) => HHMM.test(t)).sort();
  if (!starts.length) return null;
  const at = istClock(now);
  const later = starts.find((t) => t > at);
  return later ? `next ${later}` : `next tomorrow ${starts[0]}`;
}

/** Two to a row: half a 320px phone each, so the session's times and the limit's own figure are left to the one-account view. */
const TILE = 'grid min-w-0 content-start gap-1 rounded-md bg-muted px-2 py-1.5';

function Row({ id, name, now, compact = false }: { id: number; name: string | null; now: number; compact?: boolean }) {
  const { data: v, error } = usePoll(() => getSessionLossOf(id), 10_000, { deps: [id] });
  const head = name && <span className="min-w-0 truncate font-semibold text-foreground">{name}</span>;
  const quiet = (words: string) => compact ? (
    <div className={cn(TILE, 'text-[12.5px]')} aria-label={`${name} session`}>
      {head}
      <span className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{words}</span>
    </div>
  ) : (
    <div className="flex min-w-0 items-baseline justify-between gap-2 text-[13px]">
      {head ?? <span className="text-muted-foreground">Session loss limit</span>}
      <span className="min-w-0 truncate text-muted-foreground">{words}</span>
    </div>
  );
  if (!v) return quiet(error ? 'could not read' : 'reading…');
  // An answer of another shape -- an older server, a proxy's page -- is no reading: said, never a throw that takes the
  // whole Positions screen down with this card (8 Nov 2026: five phone tests found it doing exactly that).
  if (!v.setting || typeof v.setting.on !== 'boolean') return quiet('could not read');
  if (!v.setting.on) return quiet('Off');
  if (v.blocked && compact) {
    return (
      <div role="alert" className="grid min-w-0 content-start gap-0.5 rounded-md bg-[var(--down-bg)] px-2 py-1.5 text-[12.5px] text-[var(--down-text)]">
        <span className="truncate font-semibold">{name}</span>
        <span className="text-[11.5px] font-semibold">Stopped for today</span>
      </div>
    );
  }
  if (v.blocked) {
    return (
      <div role="alert" className="grid gap-0.5 rounded-md bg-[var(--down-bg)] px-2.5 py-2 text-[13px] text-[var(--down-text)]">
        <span className="font-semibold">{name ? `${name}: stopped for today` : 'Stopped for today'}</span>
        <span className="line-clamp-2 text-[12px] leading-snug">{v.blocked}</span>
      </div>
    );
  }
  const s = v.now;
  if (!s) return quiet(`No session now${nextSession(v, now) ? ` · ${nextSession(v, now)}` : ''}`);
  const loss = s.lossInr;
  const limit = s.limitInr;
  const used = loss !== null && limit ? Math.max(0, loss) / limit : 0;
  const tone = s.breachSince || used >= 0.8 ? 'down' : used >= 0.5 ? 'warn' : 'up';
  const money = (size: string) => (
    <span className={cn('shrink-0 font-semibold tabular-nums', size, loss === null ? 'text-muted-foreground' : loss > 0 ? 'text-[var(--down)]' : loss < 0 ? 'text-[var(--up)]' : '')}>
      {loss === null ? '…' : signed(-loss)}
    </span>
  );
  const left = limit === null ? 'limit …' : `${rupees(Math.max(0, limit - Math.max(0, loss ?? 0)))} left`;
  if (compact) {
    return (
      <div className={TILE} aria-label={`${name} session`}>
        <div className="flex min-w-0 items-baseline justify-between gap-1 text-[12.5px]">{head}{money('text-[13.5px]')}</div>
        <Bar value={used} tone={tone} label={`${name} loss limit used`} />
        <span className={cn('truncate text-[11px] tabular-nums', s.breachSince ? 'font-semibold text-[var(--down)]' : 'text-muted-foreground')}>
          {s.breachSince ? 'At the limit' : `${left}${limit === null ? '' : ` of ${rupees(limit)}`}`}
        </span>
      </div>
    );
  }
  return (
    <div className="grid gap-1" aria-label={name ? `${name} session` : 'This session'}>
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-[13px]">
        <span className="min-w-0 truncate">{head}{head && ' · '}<span className="tabular-nums text-muted-foreground">{s.from}–{s.to}</span></span>
        {money('text-[15px]')}
      </div>
      <Bar value={used} tone={tone} label={`${name ?? 'Session'} loss limit used`} />
      <div className={cn('flex justify-between gap-2 text-[11.5px] tabular-nums', s.breachSince ? 'font-semibold text-[var(--down)]' : 'text-muted-foreground')}>
        {s.breachSince
          ? <span>At the limit: squaring off</span>
          : <span>{left}</span>}
        <span>limit {limit === null ? '…' : rupees(limit)}</span>
      </div>
    </div>
  );
}

export function SessionLossCard() {
  const p = usePhone();
  const accounts = (p.trading ?? []).filter((a) => p.shown === 'all' || a.id === p.shown);
  if (!accounts.length) return null;
  const several = accounts.length > 1;
  return (
    <Panel title="Session loss limit">
      <div className={several ? 'grid grid-cols-2 gap-2' : 'grid gap-3'}>
        {accounts.map((a) => <Row key={a.id} id={a.id} name={several ? a.name : null} now={p.now} compact={several} />)}
      </div>
    </Panel>
  );
}
