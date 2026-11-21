import { useEffect, useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  BID_GUARD_MAX, BID_GUARD_MIN, ENTRY_GUARDS_TESTED, IV_GUARD_MAX_PTS, IV_GUARD_MIN_PTS, MOMENTUM_GUARD_MAX_PCT, MOMENTUM_GUARD_MAX_PTS,
  MOMENTUM_GUARD_MIN_PCT, MOMENTUM_GUARD_MIN_PTS, anyGuardOn, fullGuard, guardsLabel, momentumPtsAt,
  type MomentumGuard as Guard, type MomentumSides, type MomentumUnit,
} from '@/types/strategy';

/**
 * The entry guards on the strategies card, this account's (or a group's): one pill, opening to a switch for each.
 * - Momentum (owner, 30 Oct 2026: "Momentum 1h >= +250, CE mattum, default off"): no new call sold while BTC has risen its
 *   points -- or its per cent of the price (14 Nov) -- or more in the last hour. Since 21 Nov 2026 it may hold puts back
 *   after a fall too, and read the last 15 minutes as well.
 * - IV spike (21 Nov 2026): no new sale on either side while ATM IV is up its vol points or more in the hour.
 * - Thin bid (21 Nov 2026): the strike picked with fewer contracts bid than its number is not sold.
 * Each is turned on by itself (owner, 21 Nov 2026: "one by one combo enable pandra vai"), and "Fill in the tested set" puts
 * in the 30-day study's best, to look at before saving. Open trades are never touched.
 */

export type GuardNow = { perp: number; hourAgo: number; rise: number; quarterAgo?: number | null } | null;
export type IvNow = { iv: number; hourAgo: number } | null | undefined;

/** "+555", "−87": a move in points. */
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const signedPct = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;

const ptsProblem = (t: string) => {
  const n = Number(t);
  return t.trim() !== '' && Number.isInteger(n) && n >= MOMENTUM_GUARD_MIN_PTS && n <= MOMENTUM_GUARD_MAX_PTS
    ? null : `Whole points from ${MOMENTUM_GUARD_MIN_PTS} to ${MOMENTUM_GUARD_MAX_PTS}.`;
};
const pctProblem = (t: string) => {
  const n = Number(t);
  return /^\d+(\.\d{1,2})?$/.test(t.trim()) && n >= MOMENTUM_GUARD_MIN_PCT && n <= MOMENTUM_GUARD_MAX_PCT
    ? null : `A per cent from ${MOMENTUM_GUARD_MIN_PCT} to ${MOMENTUM_GUARD_MAX_PCT}, two decimals at most.`;
};
const ivProblem = (t: string) => {
  const n = Number(t);
  return /^\d+(\.\d)?$/.test(t.trim()) && n >= IV_GUARD_MIN_PTS && n <= IV_GUARD_MAX_PTS
    ? null : `IV: vol points from ${IV_GUARD_MIN_PTS} to ${IV_GUARD_MAX_PTS}, one decimal at most.`;
};
const bidProblem = (t: string) => {
  const n = Number(t);
  return /^\d+$/.test(t.trim()) && n >= BID_GUARD_MIN && n <= BID_GUARD_MAX
    ? null : `Bid size: whole contracts from ${BID_GUARD_MIN} to ${BID_GUARD_MAX.toLocaleString('en-IN')}.`;
};

/**
 * What the market-wide guards say of each side right now -- the same reading the server makes at a signal
 * (`marketGuardWhy`): the guard that would hold a call or a put back, or null where it would be sold. The thin-bid guard
 * is the strike's, so it cannot be told here.
 */
export function guardVerdict(g: Guard, now: GuardNow, iv: IvNow): { CE: string | null; PE: string | null; moveKnown: boolean } {
  const f = fullGuard(g);
  const out: { CE: string | null; PE: string | null; moveKnown: boolean } = { CE: null, PE: null, moveKnown: now !== null };
  if (f.on && now) {
    const at = momentumPtsAt(f, now.perp);
    if (at !== null && now.rise >= at) out.CE = 'momentum 1h';
    if (at !== null && f.sides === 'both' && -now.rise >= at) out.PE = 'momentum 1h';
    if (f.q15.on && now.quarterAgo) {
      const mv = ((now.perp - now.quarterAgo) / now.quarterAgo) * 100;
      if (!out.CE && mv >= f.q15.pct) out.CE = 'momentum 15m';
      if (!out.PE && f.sides === 'both' && -mv >= f.q15.pct) out.PE = 'momentum 15m';
    }
  }
  if (f.iv.on && iv && (iv.iv - iv.hourAgo) * 100 >= f.iv.pts - 1e-9) {
    out.CE ??= 'IV spike';
    out.PE ??= 'IV spike';
  }
  return out;
}

const box = 'm-0 h-7 rounded border border-solid border-border bg-[var(--bg)] px-1.5 text-right font-[inherit] text-[12px] tabular-nums text-foreground';

function Section({ title, on, onToggle, busy, children, hint }: { title: string; on: boolean; onToggle: (on: boolean) => void; busy?: boolean; children: ReactNode; hint: string }) {
  return (
    <section aria-label={title} className="border-0 border-t border-solid border-[var(--line-soft)] pt-2.5">
      <label className="flex items-center gap-2 text-[12.5px] font-semibold">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => onToggle(e.target.checked)} aria-label={`${title} on`} />
        {title}
        <span className={cn('ml-auto text-[11px] font-normal', on ? 'text-[var(--up)]' : 'text-muted-foreground')}>{on ? 'on' : 'off'}</span>
      </label>
      <p className="m-0 mb-1.5 mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{hint}</p>
      <div className={cn('grid gap-1.5', !on && 'opacity-60')}>{children}</div>
    </section>
  );
}

export function MomentumGuard({ guard, now, ivNow, busy, onSave }: {
  /** The guards as saved. */
  guard: Guard;
  /** The perp now, an hour ago (and 15 minutes ago) and the rise; null when unknown. */
  now: GuardNow;
  /** ATM IV now and an hour ago; null or absent when unknown. */
  ivNow?: IvNow;
  busy?: boolean;
  /** The guards to keep; null, back to the defaults (all off). */
  onSave: (guard: Guard | null) => Promise<boolean>;
}) {
  const saved = fullGuard(guard);
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(saved.on);
  const [unit, setUnit] = useState<MomentumUnit>(saved.unit);
  const [ptsText, setPtsText] = useState(String(saved.pts));
  const [pctText, setPctText] = useState(String(saved.pct));
  const [sides, setSides] = useState<MomentumSides>(saved.sides);
  const [q15On, setQ15On] = useState(saved.q15.on);
  const [q15Text, setQ15Text] = useState(String(saved.q15.pct));
  const [ivOn, setIvOn] = useState(saved.iv.on);
  const [ivText, setIvText] = useState(String(saved.iv.pts));
  const [bidOn, setBidOn] = useState(saved.bid.on);
  const [bidText, setBidText] = useState(String(saved.bid.min));
  const fill = (g: Required<Guard>) => {
    setOn(g.on); setUnit(g.unit); setPtsText(String(g.pts)); setPctText(String(g.pct)); setSides(g.sides);
    setQ15On(g.q15.on); setQ15Text(String(g.q15.pct)); setIvOn(g.iv.on); setIvText(String(g.iv.pts)); setBidOn(g.bid.on); setBidText(String(g.bid.min));
  };
  const savedKey = JSON.stringify(saved);
  // Closed, the form is what was saved; opened again, it starts from that.
  useEffect(() => { if (!open) fill(fullGuard(guard)); }, [open, savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only what is in force is checked: a number under a switch that is off, or the unit not chosen, is kept as saved.
  const problem = (on ? (unit === 'pct' ? pctProblem(pctText) : ptsProblem(ptsText)) : null)
    ?? (on && q15On ? pctProblem(q15Text)?.replace(/^A per cent/, '15 minutes: a per cent') ?? null : null)
    ?? (ivOn ? ivProblem(ivText) : null)
    ?? (bidOn ? bidProblem(bidText) : null);
  const num = (t: string, ok: string | null, was: number) => (ok === null ? Number(t) : was);
  const draft: Required<Guard> = {
    on, unit, sides,
    pts: num(ptsText, ptsProblem(ptsText), saved.pts),
    pct: num(pctText, pctProblem(pctText), saved.pct),
    q15: { on: q15On, pct: num(q15Text, pctProblem(q15Text), saved.q15.pct) },
    iv: { on: ivOn, pts: num(ivText, ivProblem(ivText), saved.iv.pts) },
    bid: { on: bidOn, min: num(bidText, bidProblem(bidText), saved.bid.min) },
  };
  // Both in the one key order (`fullGuard`), so the same guards compare equal.
  const edited = JSON.stringify(fullGuard(draft)) !== savedKey;
  const save = async (g: Guard | null) => { if (await onSave(g)) setOpen(false); };

  const verdict = guardVerdict(guard, now, ivNow);
  const verdictDraft = guardVerdict(draft, now, ivNow);
  const anyOn = anyGuardOn(guard);
  const blocked = verdict.CE !== null || verdict.PE !== null;
  const tone = !anyOn ? 'var(--text)' : blocked ? 'var(--down)' : 'var(--up)';
  const sideWord = (v: string | null) => (v ? 'blocked' : 'allowed');
  const typedAt = momentumPtsAt(draft, now?.perp ?? null);
  const q15Move = now?.quarterAgo ? ((now.perp - now.quarterAgo) / now.quarterAgo) * 100 : null;
  const ivUp = ivNow ? (ivNow.iv - ivNow.hourAgo) * 100 : null;
  const pill = !anyOn ? 'off'
    : `${guardsLabel(guard)} · ${saved.on && !verdict.moveKnown && !(saved.iv.on && ivNow) ? 'move unknown' : `CE ${sideWord(verdict.CE)} · PE ${sideWord(verdict.PE)}`}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="desk-badge-pill inline-flex max-w-full cursor-pointer items-center gap-1.5"
        title="Entry guards: momentum, IV spike and thin bid, each with its own switch. They hold back new sales only; open trades are not touched."
        style={anyOn
          ? { background: `color-mix(in srgb, ${tone} 12%, transparent)`, color: tone, border: `1px solid color-mix(in srgb, ${tone} 30%, transparent)` }
          : { background: 'color-mix(in srgb, var(--text) 5%, transparent)', color: 'var(--text)', border: '1px solid var(--line)' }}
      >
        <span className="shrink-0">Entry guards</span>
        <span className={cn('truncate', !anyOn && 'text-muted-foreground')}>{pill}</span>
      </PopoverTrigger>
      <PopoverContent aria-label="Entry guards" className="grid max-h-[80vh] w-[22rem] max-w-[calc(100vw-1.5rem)] gap-2.5 overflow-y-auto">
        <div>
          <p className="m-0 text-[12px] leading-snug text-muted-foreground">
            Each guard has its own switch. They hold back new sales only; open trades are not touched.
          </p>
          <button type="button" disabled={busy} onClick={() => fill({ ...ENTRY_GUARDS_TESTED, pts: draft.pts })}
                  className="m-0 mt-1.5 h-7 appearance-none rounded-md border border-solid border-border bg-transparent px-2.5 font-[inherit] text-[12px] text-foreground disabled:opacity-50">
            Fill in the tested set
          </button>
          <p className="m-0 mt-1 text-[11px] leading-snug text-muted-foreground">
            IV +5 · momentum 0.8%/1h or 0.4%/15m, both sides · bid 500. On the 30-day replay: +₹33,304, worst day −₹11,840 → −₹1,404. Nothing changes until you save.
          </p>
        </div>

        <Section title="Momentum guard" on={on} onToggle={setOn} busy={busy}
                 hint={sides === 'both' ? 'No CE sell after BTC rises this much, no PE sell after it falls this much.' : 'No CE sell after BTC rises this much. PE sells are not touched.'}>
          <div role="radiogroup" aria-label="Rise measured in" className="flex items-center gap-3 text-[12px]">
            <label className="flex items-center gap-1.5">
              <input type="radio" name="momentum-unit" checked={unit === 'pts'} disabled={busy} onChange={() => setUnit('pts')} />
              Points
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="momentum-unit" checked={unit === 'pct'} disabled={busy} onChange={() => setUnit('pct')} />
              % of BTC price
            </label>
          </div>
          <label className="flex items-center gap-2 text-[12px]">
            <span>Move in 1h</span>
            {unit === 'pct' ? (
              <input aria-label="Move in the last hour, per cent of BTC" inputMode="decimal" value={pctText} disabled={busy}
                     onChange={(e) => setPctText(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5))}
                     className={cn(box, 'w-16', on && pctProblem(pctText) && 'border-[var(--down)]')} />
            ) : (
              <input aria-label="Move in the last hour, points" inputMode="numeric" value={ptsText} disabled={busy}
                     onChange={(e) => setPtsText(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
                     className={cn(box, 'w-16', on && ptsProblem(ptsText) && 'border-[var(--down)]')} />
            )}
            <span>{unit === 'pct' ? '%' : 'pts'} or more</span>
          </label>
          {unit === 'pct' && (
            <p aria-label="In points now" className="m-0 text-[11.5px] tabular-nums text-muted-foreground">
              {typedAt !== null && now ? `= ${Math.round(typedAt)} pts at BTC ${Math.round(now.perp).toLocaleString('en-IN')}` : 'Points follow BTC\'s price.'}
            </p>
          )}
          <div role="radiogroup" aria-label="Sides" className="grid gap-1 text-[12px]">
            <label className="flex items-center gap-1.5">
              <input type="radio" name="momentum-sides" checked={sides === 'ce'} disabled={busy} onChange={() => setSides('ce')} />
              CE only (after a rise)
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="momentum-sides" checked={sides === 'both'} disabled={busy} onChange={() => setSides('both')} />
              CE and PE (CE after a rise, PE after a fall)
            </label>
          </div>
          <label className="flex flex-wrap items-center gap-2 text-[12px]">
            <input type="checkbox" checked={q15On} disabled={busy} onChange={(e) => setQ15On(e.target.checked)} aria-label="Also the last 15 minutes" />
            <span>Also a move in 15m of</span>
            <input aria-label="Move in the last 15 minutes, per cent of BTC" inputMode="decimal" value={q15Text} disabled={busy}
                   onChange={(e) => setQ15Text(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5))}
                   className={cn(box, 'w-14', on && q15On && pctProblem(q15Text) && 'border-[var(--down)]')} />
            <span>% or more</span>
          </label>
          <p aria-label="Now" className="m-0 text-[11.5px] tabular-nums text-muted-foreground">
            {now
              ? <>BTC {Math.round(now.perp).toLocaleString('en-IN')} · an hour ago {Math.round(now.hourAgo).toLocaleString('en-IN')} · <span className={cn(verdictDraft.CE?.startsWith('momentum 1h') || verdictDraft.PE?.startsWith('momentum 1h') ? 'text-[var(--down)]' : '')}>{signed(now.rise)} in 1h</span>{q15Move !== null && <> · <span className={cn(verdictDraft.CE === 'momentum 15m' || verdictDraft.PE === 'momentum 15m' ? 'text-[var(--down)]' : '')}>{signedPct(q15Move)} in 15m</span></>}</>
              : 'The move over the last hour cannot be read just now.'}
          </p>
        </Section>

        <Section title="IV spike guard" on={ivOn} onToggle={setIvOn} busy={busy}
                 hint="No new sale, CE or PE, while ATM IV has risen this many vol points in the last hour (IV 40% to 45% is 5).">
          <label className="flex items-center gap-2 text-[12px]">
            <span>ATM IV up</span>
            <input aria-label="ATM IV rise in the last hour, vol points" inputMode="decimal" value={ivText} disabled={busy}
                   onChange={(e) => setIvText(e.target.value.replace(/[^0-9.]/g, '').slice(0, 4))}
                   className={cn(box, 'w-14', ivOn && ivProblem(ivText) && 'border-[var(--down)]')} />
            <span>vol pts or more in 1h</span>
          </label>
          <p aria-label="IV now" className="m-0 text-[11.5px] tabular-nums text-muted-foreground">
            {ivNow && ivUp !== null
              ? <>ATM IV {(ivNow.iv * 100).toFixed(1)}% · an hour ago {(ivNow.hourAgo * 100).toFixed(1)}% · <span className={cn(verdictDraft.CE === 'IV spike' && 'text-[var(--down)]')}>{ivUp >= 0 ? '+' : '−'}{Math.abs(ivUp).toFixed(1)} pts</span></>
              : 'ATM IV over the last hour cannot be read just now.'}
          </p>
        </Section>

        <Section title="Thin-bid guard" on={bidOn} onToggle={setBidOn} busy={busy}
                 hint="The strike picked for a signal is not sold when fewer contracts than this are bid on it. Checked at each signal, on its own strike.">
          <label className="flex items-center gap-2 text-[12px]">
            <span>Skip under</span>
            <input aria-label="Least contracts bid on the strike" inputMode="numeric" value={bidText} disabled={busy}
                   onChange={(e) => setBidText(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                   className={cn(box, 'w-20', bidOn && bidProblem(bidText) && 'border-[var(--down)]')} />
            <span>contracts bid</span>
          </label>
        </Section>

        <p aria-label="Verdict now" className="m-0 border-0 border-t border-solid border-[var(--line-soft)] pt-2 text-[12px] tabular-nums">
          {anyGuardOn(draft)
            ? <>Now{edited ? ', as set here' : ''}: <span className={verdictDraft.CE ? 'text-[var(--down)]' : 'text-[var(--up)]'}>CE {verdictDraft.CE ? `blocked (${verdictDraft.CE})` : 'allowed'}</span> · <span className={verdictDraft.PE ? 'text-[var(--down)]' : 'text-[var(--up)]'}>PE {verdictDraft.PE ? `blocked (${verdictDraft.PE})` : 'allowed'}</span></>
            : <span className="text-muted-foreground">Every guard is off: signals are sold as before.</span>}
        </p>
        {problem && <p role="alert" className="m-0 text-[11.5px] text-[var(--down)]">{problem}</p>}
        <div className="flex flex-wrap gap-1.5">
          <button type="button" disabled={busy || problem !== null || !edited} onClick={() => void save(draft)}
                  className="m-0 h-8 appearance-none rounded-md border-0 bg-primary px-3 font-[inherit] text-[12px] font-semibold text-primary-foreground disabled:opacity-50">
            Save
          </button>
          <button type="button" disabled={busy || !anyOn} onClick={() => void save(null)}
                  className="m-0 h-8 appearance-none rounded-md border border-solid border-border bg-transparent px-3 font-[inherit] text-[12px] text-muted-foreground disabled:opacity-50">
            All off
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
