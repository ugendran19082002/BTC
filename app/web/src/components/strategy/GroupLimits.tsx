import { useEffect, useState } from 'react';
import { Loader2, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { setMomentumGuard, setReentry, setSideMax, setSignalMaxOpen, setStrikeFull, setStrikeMax, setZoneFresh } from '@/api/strategy';
import { Button } from '@/components/ui/button';
import { SideMax } from '@/components/strategy/SideMax';
import { StrikeMax } from '@/components/strategy/StrikeMax';
import { ZoneFresh } from '@/components/strategy/ZoneFresh';
import { MomentumGuard } from '@/components/strategy/MomentumGuard';
import { Reentry } from '@/components/strategy/Reentry';
import { groupOwnWords } from '@/lib/strategy-groups';
import { REENTRY_DEFAULT, type GroupOwn, type MomentumGuard as Guard, type Reentry as ReentrySetting, type SignalTf, type StrategyGroup } from '@/types/strategy';
import { cn } from '@/lib/utils';

/** The account's seven, as the Signal Strategies row has them: what a group takes where it sets nothing of its own. */
export type AccountLimits = {
  maxOpen: number; side: { CE: number; PE: number }; strikePct: number; strikeFull: 'next' | 'skip';
  zoneFresh: Record<SignalTf, number>; momentum: Guard; momentumNow: Parameters<typeof MomentumGuard>[0]['now']; reentry: ReentrySetting;
};

/**
 * A group's own limits (owner, 8 Nov 2026: "every account has these settings -- change them for each group"; "wherever
 * they are by account, by group too"). The account row's seven, for this group: each its own where it is set and the
 * account's where not, said beside it, and each back to the account's in one tap. Its at most open, side and strike limits
 * count only its own strategies' trades; the account's still count all of them, so a group is held under its account.
 */
export function GroupLimits({ group, account, busy, act, onInvalid }: {
  group: StrategyGroup;
  account: AccountLimits;
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>) => Promise<boolean>;
  onInvalid: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const own: GroupOwn = group.own ?? { maxOpen: null, ce: null, pe: null, strikeMax: null, strikeFull: null, zoneFresh: null, momentum: null, reentry: null };
  const words = groupOwnWords(own);
  const key = (what: string) => `group-limit-${what}-${group.id}`;
  const save = (what: string, fn: () => Promise<unknown>) => act(key(what), fn);
  const cap = own.maxOpen ?? account.maxOpen;
  const used = group.openNow ?? { all: 0, CE: 0, PE: 0 };
  const allBack = () => save('all', async () => {
    if (own.maxOpen !== null) await setSignalMaxOpen(null, group.id);
    if (own.ce !== null) await setSideMax('CE', null, group.id);
    if (own.pe !== null) await setSideMax('PE', null, group.id);
    if (own.strikeMax !== null) await setStrikeMax(null, group.id);
    if (own.strikeFull !== null) await setStrikeFull(null, group.id);
    if (own.zoneFresh !== null) await setZoneFresh(null, group.id);
    if (own.momentum !== null) await setMomentumGuard(null, group.id);
    if (own.reentry !== null) await setReentry(null, group.id);
  });

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
        <Button size="sm" variant={open ? 'default' : 'outline'} className="h-7 gap-1 px-2 text-[12px]" aria-expanded={open}
                aria-label={`Limits of ${group.name}`} title="This group's own at most open, CE / PE, strike, fill window, momentum guard and re-entry"
                onClick={() => setOpen(!open)}>
          <SlidersHorizontal className="h-3.5 w-3.5" /> Limits
        </Button>
        {words.length === 0
          ? <span className="text-muted-foreground">all the account&apos;s</span>
          : <span aria-label={`own limits of ${group.name}`} className="text-[var(--accent)]">Own: {words.join(' · ')}</span>}
        {(own.maxOpen !== null || own.ce !== null || own.pe !== null) && (
          <span className="tabular-nums text-muted-foreground">{used.all}{own.maxOpen !== null ? ` of ${own.maxOpen}` : ''} open</span>
        )}
      </div>

      {open && (
        <div role="group" aria-label={`limits of ${group.name}`}
             className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-[var(--line)] px-2 py-1.5">
          <Own own={own.maxOpen !== null} label="At most open" busy={busy === key('max')} onReset={() => save('max', () => setSignalMaxOpen(null, group.id))}>
            <GroupMaxOpen own={own.maxOpen} account={account.maxOpen} open={used.all} busy={busy === key('max')} onInvalid={onInvalid}
                          onSave={(n) => save('max', () => setSignalMaxOpen(n, group.id))} />
          </Own>
          <Own own={own.ce !== null || own.pe !== null} label="CE and PE max" busy={busy === key('side')}
               onReset={() => save('side', async () => { if (own.ce !== null) await setSideMax('CE', null, group.id); if (own.pe !== null) await setSideMax('PE', null, group.id); })}>
            <SideMax pct={{ CE: own.ce ?? account.side.CE, PE: own.pe ?? account.side.PE }} cap={cap} open={{ CE: used.CE, PE: used.PE }}
                     busy={busy === key('side')} onInvalid={onInvalid} onSave={(side, pct) => save('side', () => setSideMax(side, pct, group.id))} />
          </Own>
          <Own own={own.strikeMax !== null || own.strikeFull !== null} label="Strike max" busy={busy === key('strike')}
               onReset={() => save('strike', async () => { if (own.strikeMax !== null) await setStrikeMax(null, group.id); if (own.strikeFull !== null) await setStrikeFull(null, group.id); })}>
            <StrikeMax pct={own.strikeMax ?? account.strikePct} cap={cap} busiest={null} full={own.strikeFull ?? account.strikeFull}
                       busy={busy === key('strike')} onInvalid={onInvalid}
                       onSave={(n) => save('strike', () => setStrikeMax(n, group.id))} onSaveFull={(m) => save('strike', () => setStrikeFull(m, group.id))} />
          </Own>
          <Own own={own.zoneFresh !== null} label="Fill window" busy={busy === key('zone')} onReset={() => save('zone', () => setZoneFresh(null, group.id))}>
            <ZoneFresh seconds={own.zoneFresh ?? account.zoneFresh} busy={busy === key('zone')} onSave={(ch) => save('zone', () => setZoneFresh(ch ?? {}, group.id))} />
          </Own>
          <Own own={own.momentum !== null} label="Momentum guard" busy={busy === key('momentum')} onReset={() => save('momentum', () => setMomentumGuard(null, group.id))}>
            <MomentumGuard guard={own.momentum ?? account.momentum} now={account.momentumNow} busy={busy === key('momentum')}
                           onSave={(g) => save('momentum', () => setMomentumGuard(g ?? { on: false, pts: (own.momentum ?? account.momentum).pts }, group.id))} />
          </Own>
          <Own own={own.reentry !== null} label="Re-entry" busy={busy === key('reentry')} onReset={() => save('reentry', () => setReentry(null, group.id))}>
            <Reentry reentry={own.reentry ?? account.reentry} busy={busy === key('reentry')} onSave={(r) => save('reentry', () => setReentry(r ?? OFF, group.id))} />
          </Own>
          {words.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[12px]" disabled={busy === key('all')}
                    title="Every limit of this group back to the account's" onClick={() => void allBack()}>
              {busy === key('all') ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} All back to the account&apos;s
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A control's own "back to the default" inside a group is the group's own default (off), not the account's. */
const OFF: ReentrySetting = REENTRY_DEFAULT;

/** One of the group's settings, and whose it is: the group's own (with a tap back to the account's), or the account's. */
function Own({ own, label, busy, onReset, children }: { own: boolean; label: string; busy: boolean; onReset: () => void; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      {own ? (
        <button type="button" disabled={busy} onClick={onReset} aria-label={`${label}: back to the account's`} title="This group's own: tap to take the account's"
                className="inline-flex h-5 items-center gap-0.5 rounded border-0 bg-[color-mix(in_srgb,_var(--accent)_15%,_transparent)] px-1 font-[inherit] text-[10.5px] text-[var(--accent)]">
          own <RotateCcw className="h-2.5 w-2.5" />
        </button>
      ) : (
        <span aria-label={`${label}: the account's`} className="text-[10.5px] text-muted-foreground">account&apos;s</span>
      )}
    </span>
  );
}

/**
 * The group's own at most open: typed and saved when the field is left or Enter is pressed. Empty is none of its own --
 * the account's, shown greyed in the field. 1 to the account's: above it a group's limit changes nothing.
 */
function GroupMaxOpen({ own, account, open, busy, onSave, onInvalid }: {
  own: number | null; account: number; open: number; busy: boolean;
  onSave: (n: number | null) => Promise<boolean>; onInvalid: (message: string) => void;
}) {
  const [text, setText] = useState(own === null ? '' : String(own));
  useEffect(() => { setText(own === null ? '' : String(own)); }, [own]);
  const commit = () => {
    const t = text.trim();
    const next = t === '' ? null : Number(t);
    if (next === own) return;
    if (next !== null && !(Number.isInteger(next) && next >= 1 && (account <= 0 || next <= account))) {
      onInvalid(account > 0 ? `A group's at most open is a whole number from 1 to the account's ${account}; empty takes the account's.` : 'A group\'s at most open is a whole number, 1 or more; empty takes the account\'s.');
      setText(own === null ? '' : String(own));
      return;
    }
    void onSave(next).then((ok) => { if (!ok) setText(own === null ? '' : String(own)); });
  };
  const full = own !== null && open >= own;
  return (
    <label className={cn('desk-badge-pill inline-flex items-center gap-1.5', full && 'text-[var(--accent)]')}
           title="This group's own limit over its strategies' open trades -- positions and working orders. The account's still counts them all.">
      <span>At most open</span>
      <input aria-label="At most open at once, this group" inputMode="numeric" value={text} disabled={busy}
             placeholder={account > 0 ? String(account) : '–'}
             onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
             onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
             className="m-0 h-6 w-11 rounded border border-solid border-border bg-[var(--bg)] px-1 text-center font-[inherit] text-[12px] tabular-nums text-foreground placeholder:text-muted-foreground" />
      <span aria-label="open now in the group">{open} open</span>
    </label>
  );
}
