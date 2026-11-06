import { getSessionLossOf, type SessionLossView } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import { usePhone } from '@/components/mobile/phone-context';
import { Bar, Panel } from '@/components/mobile/parts';
import { cn } from '@/lib/utils';

/**
 * The session loss limit on the phone's Positions, to read only (owner, 6 Nov 2026: "session loss limit desk update
 * pandra maari iruku and view; phone side position menu la mobile friendly, user friendly view matum"). It is set on the
 * desk's Account card, or the phone's Account screen; here, each account shown: the session now, this session's money
 * so far, a bar of the limit used, and what is left before the account is squared off. On "All accounts", a row each.
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

function Row({ id, name, now }: { id: number; name: string | null; now: number }) {
  const { data: v, error } = usePoll(() => getSessionLossOf(id), 10_000, { deps: [id] });
  const head = name && <span className="font-semibold text-foreground">{name}</span>;
  const quiet = (words: string) => (
    <div className="flex min-w-0 items-baseline justify-between gap-2 text-[13px]">
      {head ?? <span className="text-muted-foreground">Session loss limit</span>}
      <span className="min-w-0 truncate text-muted-foreground">{words}</span>
    </div>
  );
  if (!v) return quiet(error ? 'could not read' : 'reading…');
  if (!v.setting.on) return quiet('Off');
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
  return (
    <div className="grid gap-1" aria-label={name ? `${name} session` : 'This session'}>
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-[13px]">
        <span className="min-w-0 truncate">{head}{head && ' · '}<span className="tabular-nums text-muted-foreground">{s.from}–{s.to}</span></span>
        <span className={cn('shrink-0 text-[15px] font-semibold tabular-nums', loss === null ? 'text-muted-foreground' : loss > 0 ? 'text-[var(--down)]' : loss < 0 ? 'text-[var(--up)]' : '')}>
          {loss === null ? '…' : signed(-loss)}
        </span>
      </div>
      <Bar value={used} tone={tone} label={`${name ?? 'Session'} loss limit used`} />
      <div className={cn('flex justify-between gap-2 text-[11.5px] tabular-nums', s.breachSince ? 'font-semibold text-[var(--down)]' : 'text-muted-foreground')}>
        {s.breachSince
          ? <span>At the limit: squaring off</span>
          : <span>{limit === null ? 'limit …' : `${rupees(Math.max(0, limit - Math.max(0, loss ?? 0)))} left`}</span>}
        <span>limit {limit === null ? '…' : rupees(limit)}</span>
      </div>
    </div>
  );
}

export function SessionLossCard() {
  const p = usePhone();
  const accounts = (p.trading ?? []).filter((a) => p.shown === 'all' || a.id === p.shown);
  if (!accounts.length) return null;
  return (
    <Panel title="Session loss limit">
      <div className="grid gap-3">
        {accounts.map((a) => <Row key={a.id} id={a.id} name={accounts.length > 1 ? a.name : null} now={p.now} />)}
      </div>
    </Panel>
  );
}
