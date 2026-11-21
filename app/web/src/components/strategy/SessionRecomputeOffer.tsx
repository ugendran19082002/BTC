import { useState, useSyncExternalStore } from 'react';
import { recomputeSessionLimit } from '@/api/desk';
import { offerSessionRecompute, onSessionRecomputeOffer, sessionRecomputeOffer } from '@/lib/session-recompute-offer';

/**
 * After lots are changed while a session runs, the offer to work its limit out again (owner, 20 Nov 2026: "1 & 2" --
 * the Session loss card's button, and this, asked at the moment of the change). Nothing changes until "Recompute now";
 * the server says no in words when it must (the loss already at the new limit, the day already stopped, ...).
 */
const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export function SessionRecomputeOffer() {
  const offer = useSyncExternalStore(onSessionRecomputeOffer, sessionRecomputeOffer, sessionRecomputeOffer);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  if (!offer && !said) return null;
  // Only a raise is offered here (the server sends no other since 21 Nov 2026): anything else is the card's own act.
  if (offer && offer.beforeInr !== null && offer.afterInr <= offer.beforeInr && !said) return null;
  const who = offer?.accountName ?? 'this account';
  const take = async () => {
    if (!offer) return;
    setBusy(true);
    try {
      const r = await recomputeSessionLimit(offer.accountId);
      setSaid({ ok: true, text: `${who}: session limit now ${rupees(r.afterInr)} until ${r.to}.` });
      offerSessionRecompute(null);
    } catch (e) {
      setSaid({ ok: false, text: `${who}: not recomputed. ${(e as Error).message}` });
      offerSessionRecompute(null);
    } finally {
      setBusy(false);
    }
  };
  if (!offer && said) {
    return (
      <p role={said.ok ? 'status' : 'alert'} className={`m-0 flex items-start justify-between gap-2 rounded-md border border-solid px-2.5 py-1.5 text-[12.5px] ${said.ok ? 'border-[var(--up)] text-[var(--up)]' : 'border-[var(--down)] text-[var(--down)]'}`}>
        <span>{said.text}</span>
        <button type="button" aria-label="Close" onClick={() => setSaid(null)} className="border-0 bg-transparent p-0 font-[inherit] text-[13px] text-muted-foreground">✕</button>
      </p>
    );
  }
  return (
    <div role="alertdialog" aria-label="Recompute the session limit" className="grid gap-2 rounded-md border border-solid border-[var(--accent)] bg-muted p-2.5 text-[12.5px] leading-snug">
      <span className="font-semibold">Lots saved. {who}&apos;s session limit was worked out at {offer!.from} with the old lots.</span>
      <span className="grid grid-cols-[auto_1fr] gap-x-3 tabular-nums">
        <span className="text-muted-foreground">Now</span><span>{offer!.beforeInr === null ? '—' : rupees(offer!.beforeInr)}</span>
        <span className="text-muted-foreground">With the new lots</span><b>{rupees(offer!.afterInr)}</b>
      </span>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => { offerSessionRecompute(null); setSaid(null); }} className="h-9 rounded-md border border-solid border-border bg-transparent font-[inherit] text-[13px] text-foreground">
          Keep {offer!.beforeInr === null ? 'it' : rupees(offer!.beforeInr)}
        </button>
        <button type="button" disabled={busy} onClick={() => void take()} className="h-9 rounded-md border-0 bg-foreground font-[inherit] text-[13px] font-semibold text-background disabled:opacity-40">
          {busy ? 'Recomputing…' : 'Recompute now'}
        </button>
      </div>
    </div>
  );
}
