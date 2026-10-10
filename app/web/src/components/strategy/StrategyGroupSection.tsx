import { useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Copy, FolderClosed, FolderInput, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { cloneGroup, deleteGroup, orderGroup, renameGroup, setGroupEnabled } from '@/api/strategy';
import { getAccounts, type BrokerAccount } from '@/api/accounts';
import { Button } from '@/components/ui/button';
import { FoldButton, useFold } from '@/components/ui/fold';
import { accountTag, groupNameProblem, onCount } from '@/lib/strategy-groups';
import { ReorderList } from '@/components/strategy/ReorderList';
import type { Strategy, StrategyGroup } from '@/types/strategy';
import { cn } from '@/lib/utils';

/**
 * One group of strategies on the Signal Strategies card (owner, 10 Oct 2026): its name, whose account, how many
 * are on, and what is done to the group as one -- every strategy on or off, renamed, cloned to this account or
 * another, removed -- with its strategies' own cards under it, folded away when not wanted.
 *
 * The group's switch is not a switch of its own: it sets each strategy's, by the same check as that strategy's
 * own switch, and the runner reads those as before. On is two taps -- it can start orders -- and says how many
 * have live orders on; off is one, the safe way. A clone is every strategy copied switched off, live orders off.
 * Removing the group keeps its strategies, in no group.
 *
 * Reorder (owner, 10 Oct 2026: "change the display order, user friendly"; "drag to order"): the cards give way to
 * one short row each, dragged by its grip or moved with up and down buttons (`ReorderList`), then Save; the group
 * itself moves up or down among its account's at once. The order is the screens' only: the runner's is its own.
 */
export function StrategyGroupSection({ group, strategies, showAccount, busy, act, canMake, onNew, onCopyIn, onMoveGroup, children }: {
  group: StrategyGroup;
  strategies: readonly Strategy[];
  /** On "All accounts": say whose group it is. */
  showAccount: boolean;
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>) => Promise<boolean>;
  /** Whether a strategy can be made from the screen as it stands (an account's tab, not "All accounts"). */
  canMake: boolean;
  onNew: () => void;
  /** Opens the copy sheet, into this group: strategies of any account and group copied in. */
  onCopyIn?: () => void;
  /** Moves the group one place among its account's (-1 up, +1 down); absent where it cannot move that way. */
  onMoveGroup?: { up?: () => void; down?: () => void };
  children: React.ReactNode;
}) {
  const [open, setOpen] = useFold(`strategy-group-${group.id}`);
  const [confirm, setConfirm] = useState<'on' | 'delete' | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [cloning, setCloning] = useState<{ accountId: number | null; name: string } | null>(null);
  const [accounts, setAccounts] = useState<BrokerAccount[] | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  // The order being set, while Reorder is open: the strategies' ids, top first.
  const [order, setOrder] = useState<string[] | null>(null);
  const { on, of } = onCount(strategies);
  const live = strategies.filter((s) => s.config.liveOrders && !s.enabled).length;
  const key = (what: string) => `group-${what}-${group.id}`;

  const twoTaps = (what: 'on' | 'delete', then: () => void) => {
    if (confirm !== what) {
      setConfirm(what);
      setTimeout(() => setConfirm((cur) => (cur === what ? null : cur)), 4_000);
      return;
    }
    setConfirm(null);
    then();
  };
  const switchAll = (enabled: boolean) => void act(key(enabled ? 'on' : 'off'), async () => {
    setSaid(null);
    const r = await setGroupEnabled(group.id, enabled);
    const turned = `${r.changed.length} turned ${enabled ? 'on' : 'off'}.`;
    setSaid(r.leftOff.length === 0 ? turned
      : `${turned} Left off, its settings do not pass: ${r.leftOff.map((x) => `${x.name} — ${x.problems.join(' ')}`).join('; ')}`);
  });
  const saveName = () => {
    if (renaming === null) return;
    const bad = groupNameProblem(renaming);
    if (bad) { setSaid(bad); return; }
    if (renaming.trim() === group.name) { setRenaming(null); return; }
    void act(key('rename'), () => renameGroup(group.id, renaming.trim())).then((ok) => { if (ok) setRenaming(null); });
  };
  const startClone = () => {
    setCloning({ accountId: group.accountId, name: '' });
    if (accounts === null) getAccounts().then((a) => setAccounts(a.accounts)).catch(() => setAccounts([]));
  };
  const sameAccount = cloning !== null && cloning.accountId === group.accountId;
  const doClone = () => {
    if (!cloning) return;
    const name = cloning.name.trim();
    if (name) { const bad = groupNameProblem(name); if (bad) { setSaid(bad); return; } }
    void act(key('clone'), async () => {
      const r = await cloneGroup(group.id, { ...(name ? { name } : {}), ...(cloning.accountId === null ? {} : { accountId: cloning.accountId }) });
      setCloning(null);
      setSaid(`Cloned as "${r.group.name}"${r.group.accountName && r.group.accountId !== group.accountId ? ` on ${r.group.accountName}` : ''}: ${r.strategies.length} strateg${r.strategies.length === 1 ? 'y' : 'ies'}, all switched off, live orders off.`);
    });
  };

  return (
    <section aria-label={`group ${group.name}`} className="fold-host rounded-xl border border-solid border-[var(--line)] bg-[var(--bg,#0a0d10)]/40 p-2" data-folded={!open}>
      {/* `fold-head`: the one row a folded section keeps (styles.css) -- without it the fold button folded away too. */}
      <div className="fold-head flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <FoldButton open={open} onToggle={() => setOpen(!open)} label={`group ${group.name}`} />
        <FolderClosed className="h-4 w-4 flex-none text-[var(--accent)]" aria-hidden />
        {renaming === null ? (
          <h3 className="m-0 min-w-0 truncate text-[14px] font-semibold text-foreground">{group.name}</h3>
        ) : (
          <span className="inline-flex items-center gap-1">
            <input
              aria-label={`New name for ${group.name}`} autoFocus maxLength={40} value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setRenaming(null); }}
              className="m-0 h-8 w-44 rounded border border-solid border-border bg-[var(--bg,#0a0d10)] px-2 font-[inherit] text-[13px] text-foreground"
            />
            <Button size="sm" className="h-8" disabled={busy === key('rename')} onClick={saveName}>
              {busy === key('rename') && <Loader2 className="h-3 w-3 animate-spin" />} Save
            </Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setRenaming(null)}>Cancel</Button>
          </span>
        )}
        {showAccount && accountTag(group) && (
          <span className="rounded bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">{accountTag(group)}</span>
        )}
        <span aria-label={`switched on in ${group.name}`} className={cn('text-[11.5px] tabular-nums', on > 0 ? 'text-[var(--up)]' : 'text-[var(--dim)]')}>
          {of === 0 ? 'empty' : `${on} of ${of} on`}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-1">
          {on < of && (
            <Button size="sm" className={cn('h-8', confirm === 'on' && 'border-[var(--warn)]')}
                    variant={confirm === 'on' ? 'outline' : 'default'}
                    aria-label={`Turn all on in ${group.name}`}
                    title="Each strategy switched on by its own check; one whose settings do not pass is left off and named."
                    disabled={busy === key('on')}
                    onClick={() => twoTaps('on', () => switchAll(true))}>
              {busy === key('on') && <Loader2 className="h-3 w-3 animate-spin" />}
              {confirm === 'on' ? `Tap again: ${of - on} on${live > 0 ? `, ${live} with live orders` : ''}` : 'Turn all on'}
            </Button>
          )}
          {on > 0 && (
            <Button size="sm" variant="outline" className="h-8" aria-label={`Turn all off in ${group.name}`}
                    title="No new entry from any of them. Trades already open keep their exits."
                    disabled={busy === key('off')} onClick={() => switchAll(false)}>
              {busy === key('off') && <Loader2 className="h-3 w-3 animate-spin" />} Turn all off
            </Button>
          )}
          {(of > 1 || onMoveGroup?.up || onMoveGroup?.down) && (
            <Button size="sm" variant={order ? 'default' : 'ghost'} className="h-8 px-2" aria-label={`Reorder ${group.name}`} aria-pressed={order !== null}
                    title="Change the order its strategies are listed in"
                    onClick={() => { setOrder(order ? null : strategies.map((s) => s.id)); if (!open) setOpen(true); }}>
              <ArrowUpDown className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-8 px-2" aria-label={`Rename ${group.name}`} title="Rename"
                  onClick={() => setRenaming(group.name)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {onCopyIn && (
            <Button size="sm" variant="ghost" className="h-8 px-2" aria-label={`Copy strategies into ${group.name}`}
                    title="Copy strategies in from any account or group, switched off" onClick={onCopyIn}>
              <FolderInput className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-8 px-2" aria-label={`Clone ${group.name}`}
                  title="A new group with a copy of every strategy, all switched off, live orders off -- on this account or another"
                  onClick={() => (cloning ? setCloning(null) : startClone())}>
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-8 px-2 text-[var(--down)]" aria-label={`Delete group ${group.name}`}
                  title="The group goes; its strategies stay, as they are, in no group."
                  disabled={busy === key('delete')}
                  onClick={() => twoTaps('delete', () => void act(key('delete'), () => deleteGroup(group.id)))}>
            {busy === key('delete') ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {confirm === 'delete' && `Tap again${of > 0 ? ` — its ${of} stay` : ''}`}
          </Button>
        </div>
      </div>

      {cloning && (
        <div role="group" aria-label={`clone ${group.name}`} className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-[var(--line)] px-2.5 py-2 text-[12px]">
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">To account</span>
            <select
              aria-label="Clone to account"
              value={cloning.accountId ?? ''}
              onChange={(e) => setCloning({ ...cloning, accountId: e.target.value === '' ? null : Number(e.target.value) })}
              className="m-0 h-8 rounded border border-solid border-border bg-[var(--bg,#0a0d10)] px-1.5 font-[inherit] text-[13px] text-foreground"
            >
              {accounts === null && <option value={group.accountId ?? ''}>{group.accountName ?? 'This account'}</option>}
              {accounts?.filter((a) => a.readable).map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.id === group.accountId ? ' (this one)' : ''}</option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-0.5">
            <span className="text-muted-foreground">Name</span>
            <input
              aria-label="Name of the clone" maxLength={40} value={cloning.name}
              placeholder={sameAccount ? `${group.name} copy` : group.name}
              onChange={(e) => setCloning({ ...cloning, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') doClone(); }}
              className="m-0 h-8 w-44 rounded border border-solid border-border bg-[var(--bg,#0a0d10)] px-2 font-[inherit] text-[13px] text-foreground"
            />
          </label>
          <Button size="sm" className="h-8" disabled={busy === key('clone') || of === 0} onClick={doClone}>
            {busy === key('clone') && <Loader2 className="h-3 w-3 animate-spin" />} Clone {of} strateg{of === 1 ? 'y' : 'ies'}
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setCloning(null)}>Cancel</Button>
          <span className="basis-full text-[11px] text-[var(--dim)]">
            {of === 0 ? 'Nothing to clone: the group is empty.'
              : `Every copy is switched off with live orders off${sameAccount ? ', named with " copy"' : ', names kept'}. Turn them on when ready.`}
          </span>
        </div>
      )}

      {said && <p role="status" className="m-0 mt-1.5 text-[12px] text-muted-foreground">{said}</p>}

      {open && order && (
        <div role="group" aria-label={`order of ${group.name}`} className="mt-2 rounded-lg border border-dashed border-[var(--accent)]/50 p-2">
          <p className="m-0 mb-1.5 text-[12px] text-muted-foreground">Drag a row by its grip, or use the arrows, then Save. Only the order they are listed in changes.</p>
          <ReorderList
            label={`strategies of ${group.name}, in order`}
            items={strategies.map((x) => ({ id: x.id, name: x.name, on: x.enabled }))}
            order={order}
            onChange={setOrder}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-9" disabled={busy === key('order')}
                    onClick={() => void act(key('order'), () => orderGroup(group.id, order)).then((ok) => { if (ok) setOrder(null); })}>
              {busy === key('order') && <Loader2 className="h-3 w-3 animate-spin" />} Save order
            </Button>
            <Button size="sm" variant="ghost" className="h-9" onClick={() => setOrder(null)}>Cancel</Button>
            {(onMoveGroup?.up || onMoveGroup?.down) && (
              <span className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                The group
                <Button size="sm" variant="outline" className="h-9 px-2" aria-label={`Move group ${group.name} up`} disabled={!onMoveGroup.up} onClick={onMoveGroup.up}>
                  <ArrowUp className="h-4 w-4" /> Up
                </Button>
                <Button size="sm" variant="outline" className="h-9 px-2" aria-label={`Move group ${group.name} down`} disabled={!onMoveGroup.down} onClick={onMoveGroup.down}>
                  <ArrowDown className="h-4 w-4" /> Down
                </Button>
              </span>
            )}
          </div>
        </div>
      )}

      {open && !order && (
        <div className="mt-2 grid gap-2">
          {children}
          {of === 0 && (
            <p className="m-0 rounded-lg border border-dashed border-[var(--line)] px-3 py-2 text-[12px] text-muted-foreground">
              No strategy in this group yet. Make one here, or move one in from its card.
            </p>
          )}
          <Button size="sm" variant="ghost" className="h-8 justify-self-start text-[12px]" disabled={!canMake}
                  title={canMake ? undefined : 'Choose an account tab first: a strategy belongs to one account'}
                  onClick={onNew}>
            <Plus className="h-3.5 w-3.5" /> New strategy in {group.name}
          </Button>
        </div>
      )}
    </section>
  );
}
