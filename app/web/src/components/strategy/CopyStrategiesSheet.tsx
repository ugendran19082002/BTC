import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { copyIntoGroup, getAllStrategies } from '@/api/strategy';
import { getAccounts } from '@/api/accounts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { copySources, groupNameProblem } from '@/lib/strategy-groups';
import type { Strategy, StrategyGroup } from '@/types/strategy';
import { cn } from '@/lib/utils';

/**
 * Copy strategies into a group (owner, 10 Oct 2026: "from another account's, another group's, into a new group or an
 * existing one -- user friendly, mobile friendly").
 *
 * Two steps on one sheet -- a bottom sheet on a phone, a dialog on a desk: where to (a group that exists, or a new
 * one, on any account), then which strategies, from every account and group, by account and group, with a search
 * and "all of this group". Every copy is made switched off with live orders off; names are kept unless the account
 * has one already (then " copy"). The server does it all or nothing.
 */
export function CopyStrategiesSheet({ open, onOpenChange, into, pick, shownAccount, onDone }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Opened from a group: copy into it. Null: chosen here. */
  into: StrategyGroup | null;
  /** Ticked when it opens: a strategy's own "Copy to group". */
  pick: readonly string[];
  /** The account being shown (null: all) -- its groups and strategies first, a new group made for it. */
  shownAccount: number | null;
  onDone: (said: string) => void;
}) {
  const [all, setAll] = useState<{ strategies: Strategy[]; groups: StrategyGroup[] } | null>(null);
  const [accounts, setAccounts] = useState<{ id: number; name: string }[]>([]);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [groupId, setGroupId] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [newAccount, setNewAccount] = useState<number | null>(shownAccount);
  const [picked, setPicked] = useState<Set<string>>(new Set(pick));
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // Read fresh each time it opens: every account's, whichever tab is shown.
  useEffect(() => {
    if (!open) return;
    setPicked(new Set(pick)); setSearch(''); setFailed(null); setLoadFailed(null);
    setMode('existing'); setNewName(''); setNewAccount(shownAccount);
    let live = true;
    getAllStrategies()
      .then((d) => { if (live) setAll({ strategies: d.strategies.filter((s) => s.config.trigger === 'signal'), groups: d.groups ?? [] }); })
      .catch((e: Error) => { if (live) setLoadFailed(e.message); });
    getAccounts().then((a) => { if (live) setAccounts(a.accounts.map((x) => ({ id: x.id, name: x.name }))); }).catch(() => { /* names from the groups */ });
    return () => { live = false; };
  }, [open]);

  const groups = all?.groups ?? [];
  // The target: the group it was opened from, else the one chosen -- the shown account's first by default.
  useEffect(() => {
    if (into || groupId || groups.length === 0) return;
    setGroupId((groups.find((g) => g.accountId === shownAccount) ?? groups[0]!).id);
  }, [groups, into, groupId, shownAccount]);
  const target = into ?? (mode === 'existing' ? groups.find((g) => g.id === groupId) ?? null : null);
  const accountChoices = accounts.length > 0 ? accounts
    : [...new Map(groups.filter((g) => g.accountId !== null).map((g) => [g.accountId!, { id: g.accountId!, name: g.accountName ?? `Account ${g.accountId}` }])).values()];
  const nameOf = (id: number | null) => accountChoices.find((a) => a.id === id)?.name ?? (id === null ? 'the desk' : `Account ${id}`);

  const sources = useMemo(
    () => copySources(all?.strategies ?? [], groups, accountChoices, { exceptGroupId: target?.id ?? null, firstAccount: shownAccount, search }),
    [all, groups, accountChoices, target, shownAccount, search],
  );
  const nameProblem = mode === 'new' && !into ? groupNameProblem(newName) : null;
  const ready = picked.size > 0 && (into || (mode === 'existing' ? target !== null : nameProblem === null));
  const toggle = (ids: string[], on: boolean) => setPicked((cur) => {
    const next = new Set(cur);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });

  const copy = async () => {
    if (!ready) { if (nameProblem) setFailed(nameProblem); return; }
    setBusy(true); setFailed(null);
    try {
      const r = await copyIntoGroup([...picked], target ? { groupId: target.id } : { newGroup: { name: newName.trim(), accountId: newAccount } });
      const renamed = r.strategies.filter((s) => / copy( \d+)?$/.test(s.name)).length;
      onDone(`Copied ${r.strategies.length} strateg${r.strategies.length === 1 ? 'y' : 'ies'} into "${r.group.name}"${r.group.accountName ? ` (${r.group.accountName})` : ''} — all switched off, live orders off.${renamed ? ` ${renamed} renamed with " copy": the account had that name already.` : ''}`);
      onOpenChange(false);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = 'm-0 h-10 w-full rounded-md border border-solid border-border bg-[var(--bg,#0a0d10)] px-2 font-[inherit] text-[14px] text-foreground sm:h-9 sm:text-[13px]';
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={into ? `Copy strategies into ${into.name}` : 'Copy strategies'}
        description="From any account and any group. Every copy starts switched off, with live orders off."
        className="sm:w-[min(600px,94vw)]"
      >
        {/* 1. Where to. */}
        <section aria-label="copy into" className="mb-3">
          <h3 className="m-0 mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">1 · Copy into</h3>
          {into ? (
            <p className="m-0 rounded-md bg-muted px-2.5 py-2 text-[13px] text-foreground">
              <b>{into.name}</b>{into.accountName && <span className="text-muted-foreground"> · {into.accountName}</span>}
            </p>
          ) : (
            <>
              <div role="radiogroup" aria-label="existing or new group" className="mb-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                {(['existing', 'new'] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                          className={cn('h-9 rounded-md border-0 font-[inherit] text-[13px] font-medium',
                            mode === m ? 'bg-[var(--accent)] text-black' : 'bg-transparent text-muted-foreground')}>
                    {m === 'existing' ? 'A group that exists' : 'A new group'}
                  </button>
                ))}
              </div>
              {mode === 'existing' ? (
                <select aria-label="Group to copy into" value={groupId} onChange={(e) => setGroupId(e.target.value)} className={field}>
                  {[...new Set(groups.map((g) => g.accountId))].map((acct) => (
                    <optgroup key={String(acct)} label={nameOf(acct)}>
                      {groups.filter((g) => g.accountId === acct).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-0.5 text-[12px] text-muted-foreground">
                    Name
                    <input aria-label="Name of the new group" maxLength={40} value={newName} placeholder="e.g. Best of both"
                           onChange={(e) => setNewName(e.target.value)} className={field} />
                  </label>
                  <label className="flex flex-col gap-0.5 text-[12px] text-muted-foreground">
                    On account
                    <select aria-label="Account of the new group" value={newAccount ?? ''} className={field}
                            onChange={(e) => setNewAccount(e.target.value === '' ? null : Number(e.target.value))}>
                      {newAccount === null && <option value="">Choose…</option>}
                      {accountChoices.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </label>
                  {newName !== '' && nameProblem && <p className="m-0 text-[12px] text-[var(--down)] sm:col-span-2">{nameProblem}</p>}
                </div>
              )}
            </>
          )}
        </section>

        {/* 2. Which strategies. */}
        <section aria-label="strategies to copy">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h3 className="m-0 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">2 · Pick strategies</h3>
            <span aria-label="picked" className="text-[12px] tabular-nums text-muted-foreground">
              {picked.size} picked
              {picked.size > 0 && (
                <button type="button" onClick={() => setPicked(new Set())}
                        className="ml-2 border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline">Clear</button>
              )}
            </span>
          </div>
          <label className="relative mb-2 block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input aria-label="Search strategies" value={search} placeholder="Search by name"
                   onChange={(e) => setSearch(e.target.value)} className={cn(field, 'pl-8')} />
          </label>
          {loadFailed && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">{loadFailed}</p>}
          {!all && !loadFailed && <p className="m-0 flex items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading every account&apos;s strategies…</p>}
          {all && sources.length === 0 && (
            <p className="m-0 rounded-md border border-dashed border-[var(--line)] px-3 py-3 text-[12.5px] text-muted-foreground">
              {search ? `No strategy named like "${search}".` : 'No other strategy to copy.'}
            </p>
          )}
          <div className="grid gap-3">
            {sources.map((a) => (
              <div key={String(a.accountId)} aria-label={`account ${a.accountName}`} role="group">
                <h4 className="m-0 mb-1 text-[13px] font-semibold text-foreground">{a.accountName}</h4>
                <div className="grid gap-1.5">
                  {a.sections.map((sec) => {
                    const ids = sec.strategies.map((s) => s.id);
                    const allOn = ids.every((id) => picked.has(id));
                    const label = sec.group ? sec.group.name : 'Not in a group';
                    return (
                      <div key={sec.group?.id ?? 'none'} role="group" aria-label={`${a.accountName} · ${label}`}
                           className="rounded-lg border border-solid border-[var(--line)] px-2.5 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-[12.5px] font-medium text-muted-foreground">
                            {label} · {ids.length}
                          </span>
                          <button type="button" onClick={() => toggle(ids, !allOn)}
                                  aria-label={`${allOn ? 'Unpick' : 'Pick'} all of ${label} (${a.accountName})`}
                                  className="h-8 flex-none border-0 bg-transparent px-1 font-[inherit] text-[12px] text-[var(--accent)]">
                            {allOn ? 'Unpick all' : 'Pick all'}
                          </button>
                        </div>
                        <ul className="m-0 list-none p-0">
                          {sec.strategies.map((s) => (
                            <li key={s.id} className="border-t border-solid border-[var(--line-soft)] first:border-t-0">
                              <Checkbox
                                checked={picked.has(s.id)}
                                onChange={(e) => toggle([s.id], e.target.checked)}
                                aria-label={`Copy ${s.name} (${a.accountName})`}
                                className="flex w-full py-2"
                                label={
                                  <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                                    <span className="truncate text-[14px] text-foreground sm:text-[13px]">{s.name}</span>
                                    <span className={cn('flex-none text-[11px]', s.enabled ? 'text-[var(--up)]' : 'text-[var(--dim)]')}>
                                      {s.enabled ? 'on' : 'off'}{s.config.liveOrders ? ' · live' : ''}
                                    </span>
                                  </span>
                                }
                              />
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        <SheetFooter className="flex-col sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 text-[11.5px] leading-snug text-muted-foreground">
            {failed ? <span role="alert" className="text-[var(--down)]">{failed}</span>
              : target ? `Into "${target.name}" on ${target.accountName ?? nameOf(target.accountId)}. Copies start off, live orders off.`
                : mode === 'new' ? `Into a new group on ${nameOf(newAccount)}. Copies start off, live orders off.` : 'Choose where to copy them.'}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button variant="outline" className="h-10 sm:h-9" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button className="h-10 sm:h-9" disabled={!ready || busy} onClick={() => void copy()}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Copy {picked.size || ''} strateg{picked.size === 1 ? 'y' : 'ies'}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
