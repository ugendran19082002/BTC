import { getActivity } from '@/api/phone';
import { usePoll } from '@/hooks/usePoll';
import { sideCaps } from '@/lib/side-max';
import { cn } from '@/lib/utils';
import type { StrategyStatus } from '@/types/strategy';
import { usePhoneData } from '@/components/mobile/phone-context';
import { Panel } from '@/components/mobile/parts';

/**
 * The limits on open trades, on the phone (owner, 12 Oct 2026: "show it on the phone -- user friendly, mobile
 * friendly"): how much of "at most open" is in use, and each side's own limit under it -- calls and puts, each a
 * per cent of it -- as three bars a thumb-length wide, with the count in words beside each. A side at its limit is
 * in the warning colour and says what follows: its next signal is skipped. Read only here; the limits are set on
 * the desk. With an account chosen it is that account's; on "All accounts", one block for each.
 */

type Limits = Pick<StrategyStatus, 'signalMaxOpen' | 'openNow' | 'signalSideMaxPct' | 'openBySide'>;

/** One bar: what it is, how many of how many, and the share filled. Full is said in a word as well as a colour. */
function Bar({ label, now, most, note, name }: { label: string; now: number; most: number; note?: string; name: string }) {
  const full = most > 0 ? now >= most : now > 0;
  const share = most > 0 ? Math.min(1, now / most) : full ? 1 : 0;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13.5px] font-medium">{label}{note && <span className="ml-1.5 text-[11.5px] font-normal text-muted-foreground">{note}</span>}</span>
        <span className={cn('flex-none text-[13.5px] tabular-nums', full ? 'font-semibold text-[var(--warn)]' : 'text-foreground')}>
          {now} of {most}{full ? ' · full' : ''}
        </span>
      </div>
      <div role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={most} aria-valuenow={Math.min(now, most)}
           className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', full ? 'bg-[var(--warn)]' : 'bg-[var(--up)]')} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

/** One account's limits: the cap's bar, then each side's. Nothing where the server sends none (an older one). */
export function LimitsBlock({ d, title }: { d: Limits; title?: string }) {
  const cap = d.signalMaxOpen ?? 0;
  const open = d.openBySide;
  if (!open || !d.signalSideMaxPct) return null;
  const caps = sideCaps(cap, d.signalSideMaxPct);
  const who = title ? `${title}: ` : '';
  return (
    <section aria-label={title ? `open limits of ${title}` : 'open limits'} className="grid gap-2.5">
      {title && <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">{title}</h3>}
      {!caps ? (
        <p className="m-0 text-[13.5px] text-muted-foreground">
          No &ldquo;at most open&rdquo; limit is set, so neither side has one: <b className="text-foreground">{d.openNow ?? open.CE + open.PE} open</b> · CE {open.CE} · PE {open.PE}.
        </p>
      ) : (
        <>
          <Bar label="All open trades" now={d.openNow ?? open.CE + open.PE} most={cap} name={`${who}open trades, of at most open`} />
          <Bar label="CE" note={`max ${d.signalSideMaxPct.CE}%`} now={open.CE} most={caps.CE} name={`${who}CE open, of its limit`} />
          <Bar label="PE" note={`max ${d.signalSideMaxPct.PE}%`} now={open.PE} most={caps.PE} name={`${who}PE open, of its limit`} />
          {(open.CE >= caps.CE || open.PE >= caps.PE) && (
            <p className="m-0 text-[12.5px] leading-snug text-[var(--warn)]">
              {[open.CE >= caps.CE ? 'CE' : null, open.PE >= caps.PE ? 'PE' : null].filter(Boolean).join(' and ')} at {open.CE >= caps.CE && open.PE >= caps.PE ? 'their limits' : 'its limit'}:
              {' '}the next signal that way is skipped until one closes.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function OpenLimits({ shown }: { /** The chosen account's read, already on the screen; null on "All accounts". */ shown: Limits | null }) {
  const p = usePhoneData();
  const every = p.accountParam === null;
  const accounts = (p.accounts ?? []).filter((a) => a.active);
  // On "All accounts" each account is read for itself: a limit is one account's, and the read above is the desk's own.
  const each = usePoll(
    () => (every ? Promise.all(accounts.map((a) => getActivity(a.id).then((d) => ({ id: a.id, name: a.name, d })))) : Promise.resolve([])),
    30_000, { deps: [every, accounts.map((a) => a.id).join(',')] },
  );
  const blocks = every
    ? (each.data ?? []).filter((x) => x.d.openBySide && x.d.signalSideMaxPct)
    : shown && shown.openBySide && shown.signalSideMaxPct ? [{ id: p.accountParam!, name: '', d: shown }] : [];
  if (blocks.length === 0) return null;
  return (
    <Panel title="Open limits">
      <div className="grid gap-4">
        {blocks.map((b) => <LimitsBlock key={b.id} d={b.d} title={every ? b.name : undefined} />)}
      </div>
      <p className="m-0 mt-2.5 text-[11.5px] text-muted-foreground">CE and PE each have their own limit; together they stay within &ldquo;at most open&rdquo;. Set on the desk&apos;s Strategy screen.</p>
    </Panel>
  );
}
