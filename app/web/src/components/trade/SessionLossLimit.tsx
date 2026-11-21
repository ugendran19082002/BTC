import { useEffect, useState } from 'react';
import { getSessionLoss, previewSessionRecompute, recomputeSessionLimit, saveSessionLoss, type SessionLossSetting, type SessionRecompute, type SessionRule } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import { Switch } from '@/components/ui/switch';
import { NumberField } from '@/components/ui/number-field';
import { cn } from '@/lib/utils';

/**
 * The session loss limit of the account shown (owner, 4 Nov 2026: "a loss limit by the session, an hour at a time --
 * 7:00 to 8:00 AM, ₹1,000 on an account; lost in that time, the whole account squared off; set for each hour; off by
 * default on every account", then "once hit, that day's trading stops in full; tomorrow as usual", then "the limit in an
 * amount or a %, either").
 *
 * The sessions are edited as a draft and kept with Save, so a half-typed row never stands as a rule. The session now is
 * read every ten seconds: what it has lost against its limit, and whether the account is stopped for the day.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const pad = (n: number) => String(n).padStart(2, '0');
const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const clock = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(11, 16);
const limitText = (r: Pick<SessionRule, 'limit' | 'unit'>) => (r.unit === 'inr' ? rupees(r.limit) : `${r.limit}% of the "At most open" margin`);
const USDINR = 85;

/** What is wrong with the sessions as typed, in words; empty when they can be kept (the server's own rules). */
export function draftProblems(d: SessionLossSetting): string[] {
  const bad: string[] = [];
  d.sessions.forEach((s, i) => {
    const n = i + 1;
    if (!HHMM.test(s.from) || !HHMM.test(s.to)) bad.push(`Session ${n}: give both times.`);
    else if (mins(s.from) >= mins(s.to)) bad.push(`Session ${n}: it must end after it starts.`);
    if (!(s.limit > 0)) bad.push(`Session ${n}: the limit must be above 0.`);
    else if (s.unit === 'pct' && s.limit > 100) bad.push(`Session ${n}: at most 100% of the "At most open" margin.`);
  });
  const ok = d.sessions.filter((s) => HHMM.test(s.from) && HHMM.test(s.to)).map((s, i) => ({ a: mins(s.from), b: mins(s.to), i })).sort((x, y) => x.a - y.a);
  for (let k = 1; k < ok.length; k++) if (ok[k]!.a < ok[k - 1]!.b) bad.push(`Sessions ${ok[k - 1]!.i + 1} and ${ok[k]!.i + 1} overlap.`);
  if (d.on && d.sessions.length === 0) bad.push('Add a session to switch it on.');
  return bad;
}

/** Every hour from `from` to `to`, each with the same limit: the quick way to "an hour at a time". */
export const everyHour = (from: number, to: number, limit: number, unit: SessionRule['unit']): SessionRule[] =>
  Array.from({ length: Math.max(0, to - from) }, (_, i) => ({ from: `${pad(from + i)}:00`, to: `${pad(from + i + 1)}:00`, limit, unit }));

const same = (a: SessionLossSetting, b: SessionLossSetting) => JSON.stringify(a) === JSON.stringify(b);

export function SessionLossLimit({ several = false }: { several?: boolean }) {
  const { data, error, refresh } = usePoll(getSessionLoss, 10_000, { enabled: !several });
  const kept = data?.setting ?? null;
  const [draft, setDraft] = useState<SessionLossSetting | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Working the session's limit out again (20 Nov 2026): what it would become, shown to confirm; then done, or refused.
  const [offer, setOffer] = useState<SessionRecompute | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputed, setRecomputed] = useState<string | null>(null);
  useEffect(() => { if (kept && !draft) setDraft(kept); }, [kept]); // eslint-disable-line react-hooks/exhaustive-deps

  if (several) {
    return <p className="m-0 text-[12px] text-muted-foreground">Session loss limit: set on each account&apos;s own tab.</p>;
  }
  if (!data || !draft) return <p className="m-0 text-[12px] text-muted-foreground">{error ? `Session loss limit: ${error.message}` : 'Reading the session loss limit…'}</p>;

  const changed = !same(draft, data.setting);
  const problems = draftProblems(draft);
  const row = (i: number, patch: Partial<SessionRule>) => setDraft((d) => d && ({ ...d, sessions: d.sessions.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
  const save = async () => {
    setBusy(true); setRefusal(null);
    try {
      const r = await saveSessionLoss(draft);
      setDraft(r.setting);
      await refresh();
    } catch (e) {
      setRefusal((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const now = data.now;
  const askRecompute = async () => {
    setRecomputing(true); setRecomputed(null);
    try { setOffer(await previewSessionRecompute()); } catch (e) { setOffer({ ok: false, reason: (e as Error).message }); } finally { setRecomputing(false); }
  };
  const doRecompute = async () => {
    setRecomputing(true);
    try {
      const r = await recomputeSessionLimit();
      setOffer(null);
      setRecomputed(`Limit worked out again: ${r.beforeInr === null ? '' : `${rupees(r.beforeInr)} → `}${rupees(r.afterInr)} for the rest of the session.`);
      await refresh();
    } catch (e) {
      setOffer({ ok: false, reason: (e as Error).message });
    } finally {
      setRecomputing(false);
    }
  };
  // What a % is of: "At most open" × the margin one position takes, in rupees -- never the wallet.
  const base = data.pctBase;
  const baseInr = base?.totalUsd != null ? base.totalUsd * USDINR : null;
  const anyPct = draft.sessions.some((s) => s.unit === 'pct');
  const used = now && now.lossInr !== null && now.limitInr ? Math.max(0, Math.min(1, now.lossInr / now.limitInr)) : 0;
  const time = (i: number, end: 'from' | 'to', value: string) => (
    <input
      type="time" value={value} aria-label={`Session ${i + 1} ${end === 'from' ? 'from' : 'to'}`}
      onChange={(e) => row(i, { [end]: e.target.value })}
      className="h-9 w-[92px] rounded-md border border-solid border-border bg-transparent px-1.5 font-[inherit] text-[13px] tabular-nums text-foreground"
    />
  );

  return (
    <section aria-label="Session loss limit" className="grid min-w-0 gap-2">
      <Switch
        label="Session loss limit" checked={draft.on} onCheckedChange={(v) => setDraft((d) => d && ({ ...d, on: v }))}
        description={draft.on
          ? 'If a session loses its limit (held 15 s), every position on this account is squared off and it takes no new entry for the rest of the day. Tomorrow it trades as usual.'
          : 'Off: no session limit on this account.'}
      />

      {data.blocked && (
        <p role="alert" className="m-0 rounded-md border border-solid border-[var(--down)] px-2.5 py-1.5 text-[12.5px] text-[var(--down)]">
          Stopped for today. {data.blocked}
        </p>
      )}
      {now && !data.blocked && (
        <div className="grid gap-1" aria-label="This session">
          <div className="flex justify-between text-[12px] tabular-nums">
            <span>Now {now.from}–{now.to}</span>
            <span className={cn((now.lossInr ?? 0) > 0 ? 'text-[var(--down)]' : 'text-muted-foreground')}>
              {now.lossInr === null ? 'reading…' : now.lossInr > 0 ? `lost ${rupees(now.lossInr)}` : `up ${rupees(-now.lossInr)}`}
              {' of '}{now.limitInr === null ? limitText(now) : rupees(now.limitInr)}
              {now.breachSince ? ' · at the limit' : ''}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--line)]">
            <div className={cn('h-full', used >= 0.8 ? 'bg-[var(--down)]' : 'bg-[var(--accent)]')} style={{ width: `${used * 100}%` }} />
          </div>
          {now.unit === 'pct' && !offer && (
            <button
              type="button" disabled={recomputing} onClick={() => void askRecompute()}
              title="Work this session's limit out again with the lots the strategies trade now: after a lot change in the session"
              className="h-9 justify-self-start rounded-md border border-solid border-border bg-transparent px-2.5 font-[inherit] text-[13px] text-foreground disabled:opacity-40"
            >
              {recomputing ? 'Working it out…' : '↻ Recompute limit'}
            </button>
          )}
          {offer && offer.ok && offer.lowers && (
            // In a session the line only goes up (owner, 21 Nov 2026): a lower one is said, never offered.
            <p role="alert" className="m-0 flex items-start justify-between gap-2 rounded-md border border-solid border-[var(--down)] p-2 text-[12px] leading-snug text-[var(--down)]">
              <span>
                Not changed: during the {offer.from}–{offer.to} session the limit can only go up. With the lots traded now it
                would be {rupees(offer.afterInr)}, under the {rupees(offer.beforeInr ?? 0)} it is.
              </span>
              <button type="button" aria-label="Close" onClick={() => setOffer(null)} className="border-0 bg-transparent p-0 font-[inherit] text-[13px] text-muted-foreground">✕</button>
            </p>
          )}
          {offer && offer.ok && !offer.lowers && (
            <div role="alertdialog" aria-label="Recompute the session limit" className="grid gap-2 rounded-md border border-solid border-[var(--accent)] bg-muted p-2.5 text-[12.5px] leading-snug">
              <span className="font-semibold">Recompute this session&apos;s limit?</span>
              <span className="grid grid-cols-[auto_1fr] gap-x-3 tabular-nums">
                <span className="text-muted-foreground">Now</span><span>{offer.beforeInr === null ? '—' : rupees(offer.beforeInr)} (worked out at {offer.from})</span>
                <span className="text-muted-foreground">New</span><b>{rupees(offer.afterInr)} ({offer.limit}% with the lots traded now)</b>
              </span>
              <span className="text-muted-foreground">Lost so far {rupees(Math.max(0, offer.lossInr))}. Kept until {offer.to}.</span>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setOffer(null)} className="h-9 rounded-md border border-solid border-border bg-transparent font-[inherit] text-[13px] text-foreground">Cancel</button>
                <button type="button" disabled={recomputing} onClick={() => void doRecompute()} className="h-9 rounded-md border-0 bg-foreground font-[inherit] text-[13px] font-semibold text-background disabled:opacity-40">
                  {recomputing ? 'Recomputing…' : 'Recompute'}
                </button>
              </div>
            </div>
          )}
          {offer && !offer.ok && (
            <p role="alert" className="m-0 flex items-start justify-between gap-2 text-[12px] text-[var(--down)]">
              <span>Not recomputed: {offer.reason}</span>
              <button type="button" aria-label="Close" onClick={() => setOffer(null)} className="border-0 bg-transparent p-0 font-[inherit] text-[13px] text-muted-foreground">✕</button>
            </p>
          )}
          {recomputed && <p role="status" className="m-0 text-[12px] text-[var(--up)]">{recomputed}</p>}
        </div>
      )}

      <div className="grid gap-1.5">
        {draft.sessions.map((s, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5" aria-label={`Session ${i + 1}`}>
            {time(i, 'from', s.from)}<span className="text-muted-foreground">–</span>{time(i, 'to', s.to)}
            <NumberField
              label={`Session ${i + 1} limit`} value={s.limit} decimals={s.unit === 'pct' ? 2 : 0}
              unit={s.unit === 'pct' ? '%' : undefined} unitBefore={s.unit === 'inr' ? '₹' : undefined}
              onChange={(n) => row(i, { limit: n })} className="w-[110px]"
            />
            <div role="group" aria-label={`Session ${i + 1} limit in`} className="flex overflow-hidden rounded-md border border-solid border-border">
              {(['inr', 'pct'] as const).map((u) => (
                <button
                  key={u} type="button" aria-pressed={s.unit === u} onClick={() => row(i, { unit: u })}
                  className={cn('h-9 min-w-[36px] border-0 px-2 font-[inherit] text-[13px]', s.unit === u ? 'bg-[var(--accent-fill)] font-semibold text-foreground' : 'bg-transparent text-muted-foreground')}
                >
                  {u === 'inr' ? '₹' : '%'}
                </button>
              ))}
            </div>
            {s.unit === 'pct' && baseInr !== null && s.limit > 0 && (
              <span className="text-[12px] tabular-nums text-muted-foreground">≈ {rupees((s.limit / 100) * baseInr)}</span>
            )}
            <button
              type="button" aria-label={`Remove session ${i + 1}`} onClick={() => setDraft((d) => d && ({ ...d, sessions: d.sessions.filter((_, k) => k !== i) }))}
              className="h-9 w-9 rounded-md border-0 bg-transparent font-[inherit] text-[15px] text-muted-foreground"
            >
              ✕
            </button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setDraft((d) => {
              if (!d) return d;
              // The hour after the last session, with its limit; the first is 07:00-08:00 at ₹1,000.
              const last = d.sessions[d.sessions.length - 1];
              const start = Math.min(22, last && HHMM.test(last.to) ? Math.floor(mins(last.to) / 60) : 7);
              return { ...d, sessions: [...d.sessions, { from: `${pad(start)}:00`, to: `${pad(start + 1)}:00`, limit: last?.limit ?? 1000, unit: last?.unit ?? 'inr' }] };
            })}
            className="h-9 rounded-md border border-solid border-border bg-transparent px-2.5 font-[inherit] text-[13px] text-foreground"
          >
            + Add session
          </button>
          <button
            type="button" title="One session each hour, 07:00 to 17:00, all with the first session's limit"
            onClick={() => setDraft((d) => d && ({ ...d, sessions: everyHour(7, 17, d.sessions[0]?.limit ?? 1000, d.sessions[0]?.unit ?? 'inr') }))}
            className="h-9 rounded-md border border-solid border-border bg-transparent px-2.5 font-[inherit] text-[13px] text-foreground"
          >
            Every hour 07:00–17:00
          </button>
        </div>
      </div>

      {anyPct && (
        <p className="m-0 text-[12px] leading-snug text-muted-foreground" aria-label="What a % is of">
          {base && base.maxOpen > 0 && base.perPositionUsd !== null
            ? <>% is of &ldquo;At most open&rdquo; <b className="text-foreground">{base.maxOpen}</b> × {rupees(base.perPositionUsd * USDINR)} margin a position ({base.source === 'delta' ? 'Delta\'s, measured' : 'the desk\'s model'}) = <b className="text-foreground">{rupees(baseInr!)}</b>, read when each session begins. Not the wallet.</>
            : base && base.maxOpen === 0
              ? <span className="text-[var(--down)]">% needs &ldquo;At most open&rdquo; set on this account (Strategy screen): with none, a % session has no limit.</span>
              : 'Pricing the margin a position takes…'}
        </p>
      )}

      {(problems.length > 0 || refusal) && (
        <p role="alert" className="m-0 text-[12px] text-[var(--down)]">{refusal ?? problems.join(' ')}</p>
      )}
      {changed && (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button" disabled={busy || problems.length > 0} onClick={() => void save()}
            className="h-10 rounded-md border-0 bg-foreground font-[inherit] text-[14px] font-semibold text-background disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button" onClick={() => { setDraft(data.setting); setRefusal(null); }}
            className="h-10 rounded-md border border-solid border-border bg-transparent font-[inherit] text-[14px] text-foreground"
          >
            Cancel
          </button>
        </div>
      )}

      {data.hits.length > 0 && (
        <ul aria-label="Squared off by the session limit" className="m-0 grid list-none gap-0.5 p-0 text-[11.5px] text-muted-foreground">
          {data.hits.slice(0, 5).map((h) => (
            <li key={`${h.day}-${h.from}-${h.at}`}>
              {h.day.slice(5)} {clock(h.at)} · {h.from}–{h.to} lost {rupees(h.lossInr)} of {rupees(h.limitInr)} · {h.closed} closed
              {h.failed ? <span className="text-[var(--down)]"> · {h.failed} failed</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
