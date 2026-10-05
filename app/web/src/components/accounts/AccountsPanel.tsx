import { useEffect, useState } from 'react';
import { Check, Pencil, PlugZap, Plus, Star, Trash2 } from 'lucide-react';
import {
  addAccount, getAccounts, makeAccountDefault, removeAccount, renameAccount, setAccountActive, testAccount,
  type AccountsAnswer, type BrokerAccount,
} from '@/api/accounts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeInput } from '@/components/auth/CodeInput';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Input } from '@/components/ui/input';
import { usePoll } from '@/hooks/usePoll';
import { ago } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The broker accounts (owner, 5 Oct 2026): whose API key the desk trades with.
 *
 * Add an account, name it, test its connection, switch it on or off, choose the
 * default -- the one the desk trades on -- and remove it. The key and the secret
 * are typed here once and sent to the server, which encrypts them; nothing
 * sends them back, so this screen only ever has the key's last four characters.
 *
 * Two things ask twice: removing an account, and choosing a default while the
 * desk is live, because from that tap on real orders go to another account.
 *
 * Removing takes a fresh authenticator code as well: a signed-in browser may
 * look and switch, but destroying a key is not undone by signing in again.
 *
 * Some accounts cannot be removed at all, only switched off -- the last one,
 * one with trades or strategies on record, the one the desk is live on. The
 * server holds the rule and says which; the button here is off and says why.
 * A key is replaced by adding the new one first, then removing the old.
 */

type Draft = { name: string; description: string; apiKey: string; apiSecret: string };
const EMPTY: Draft = { name: '', description: '', apiKey: '', apiSecret: '' };
type Asking = { id: number; what: 'remove' | 'default' } | null;

const field = 'grid gap-1 text-[11.5px] text-muted-foreground';

export function AccountsPanel() {
  const { data, error } = usePoll(getAccounts, 30_000);
  const [view, setView] = useState<AccountsAnswer | null>(null);
  useEffect(() => { if (data) setView(data); }, [data]);

  /** `${id}:${action}` while a request is out, so its button waits and no other is pressed over it. */
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ id: number | 'new'; ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<{ id: number; name: string; description: string } | null>(null);

  /** One request: its answer is the new list; a refusal is said beside the account it was about. */
  const run = async (id: number | 'new', action: string, call: () => Promise<AccountsAnswer>, done?: (a: AccountsAnswer) => { ok: boolean; text: string } | null) => {
    setBusy(`${id}:${action}`);
    setSaid(null);
    setAsking(null);
    try {
      const answer = await call();
      setView(answer);
      const result = done?.(answer) ?? null;
      if (result) setSaid({ id, ...result });
      return true;
    } catch (e) {
      setSaid({ id, ok: false, text: (e as Error).message });
      // A refusal may still have changed something (a failed test is written on the row): read the list again.
      void getAccounts().then(setView).catch(() => {});
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const ok = await run('new', 'add', () => addAccount(draft), (a) => {
      const made = a.accounts.find((x) => x.name.toLowerCase() === draft.name.trim().replace(/\s+/g, ' ').toLowerCase());
      if (!made) return { ok: true, text: 'Saved.' };
      // Saved either way; a key that failed its test says so in the failing colour, so it is not read as working.
      return { ok: made.lastTest?.ok !== false, text: `Saved "${made.name}"${made.isDefault ? ' as the default' : ''}. ${made.lastTest?.detail ?? ''}`.trim() };
    });
    // The key is not kept on the screen a moment longer than the request that carried it.
    if (ok) { setDraft(EMPTY); setAdding(false); }
  };

  const accounts = view?.accounts ?? [];
  const live = view?.mode === 'live';
  const full = view ? accounts.length >= view.max : false;
  const draftReady = draft.name.trim() !== '' && draft.apiKey.trim() !== '' && draft.apiSecret.trim() !== '';

  return (
    <CollapsibleCard
      id="logs-accounts"
      title="Broker accounts"
      ariaLabel="broker accounts"
      right={view && (
        <span className="text-[11px] text-muted-foreground">
          {accounts.length} of {view.max} · desk is <b className={live ? 'text-[var(--down)]' : 'text-foreground'}>{live ? 'LIVE' : 'on paper'}</b>
        </span>
      )}
    >
      <p className="m-0 mb-2 text-[12px] text-muted-foreground">
        The desk trades on the <b className="text-foreground">default</b> account. An API key and its secret are encrypted on the server as they
        are saved and are never shown again — only the key's last four characters.
      </p>
      {error && !view && <p role="alert" className="m-0 mb-2 text-[12px] text-[var(--down)]">Could not read the accounts: {error.message}</p>}
      {view && !view.canStore && (
        <p role="alert" className="m-0 mb-2 text-[12px] text-[var(--warn)]">
          The server has no DESK_SESSION_SECRET, so it cannot encrypt a key. No account can be added until it is set.
        </p>
      )}

      {view?.envKeyLeft && (
        <p className="m-0 mb-2 rounded-md border border-solid border-[#d2992255] bg-[#d2992215] px-2.5 py-1.5 text-[12px] text-[var(--warn)]">
          The server's .env still holds an API key. It is no longer read — the accounts here are what the desk uses — so empty
          DELTA_API_KEY and DELTA_API_SECRET there.
        </p>
      )}
      {view && accounts.length === 0 && (
        <p className="m-0 mb-2 text-[12px] text-muted-foreground">No account yet. Add one to trade live; until then the desk stays on paper.</p>
      )}
      <ul aria-label="accounts" className="m-0 grid list-none gap-2 p-0">
        {accounts.map((a) => (
          <AccountRow
            key={a.id} a={a} live={live} only={accounts.length === 1} busy={busy} asking={asking}
            said={said && said.id === a.id ? said : null}
            editing={editing && editing.id === a.id ? editing : null}
            onEdit={setEditing}
            onAsk={setAsking}
            // What the test said is written on the row itself, with when.
            onTest={() => run(a.id, 'test', () => testAccount(a.id))}
            onActive={(on) => run(a.id, 'active', () => setAccountActive(a.id, on), (r) => ({
              ok: true,
              text: !on ? 'Switched off. It is kept, and not used.'
                : r.accounts.find((x) => x.id === a.id)?.isDefault && !a.isDefault ? 'Switched on. The desk trades on it.' : 'Switched on.',
            }))}
            onDefault={() => run(a.id, 'default', () => makeAccountDefault(a.id), () => ({ ok: true, text: `The desk now trades on "${a.name}".` }))}
            onRemove={(code) => run(a.id, 'remove', () => removeAccount(a.id, code))}
            onRename={async () => {
              if (!editing) return;
              if (await run(a.id, 'rename', () => renameAccount(a.id, { name: editing.name, description: editing.description }))) setEditing(null);
            }}
          />
        ))}
      </ul>

      {adding ? (
        <form
          aria-label="add an account" className="mt-3 grid gap-2 rounded-md border border-solid border-border p-3"
          onSubmit={(e) => { e.preventDefault(); if (draftReady && !busy) void save(); }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={field}>Name
              <Input value={draft.name} maxLength={40} placeholder="Main account" autoComplete="off"
                     onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className={field}>Description (optional)
              <Input value={draft.description} maxLength={200} placeholder="What this account is for" autoComplete="off"
                     onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>
            <label className={field}>API key
              <Input value={draft.apiKey} autoComplete="off" spellCheck={false} autoCapitalize="none"
                     onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
            </label>
            <label className={field}>API secret
              <Input type="password" value={draft.apiSecret} autoComplete="new-password" spellCheck={false}
                     onChange={(e) => setDraft({ ...draft, apiSecret: e.target.value })} />
            </label>
          </div>
          <p className="m-0 text-[11px] text-[var(--dim)]">
            Delta Exchange India. Make the key on Delta with trading allowed and this server's IP on its whitelist. It is tested as it is saved.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={!draftReady || busy !== null}>{busy === 'new:add' ? 'Saving…' : 'Save account'}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft(EMPTY); setAdding(false); setSaid(null); }}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!view || full || !view.canStore} onClick={() => { setAdding(true); setSaid(null); }}>
            <Plus size={13} aria-hidden /> Add account
          </Button>
          {full && <span className="text-[11px] text-muted-foreground">At most {view!.max} accounts. Remove one to add another.</span>}
        </div>
      )}
      {said && said.id === 'new' && (
        <p role={said.ok ? 'status' : 'alert'} className={cn('m-0 mt-2 text-[12px]', said.ok ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{said.text}</p>
      )}
    </CollapsibleCard>
  );
}

function AccountRow({ a, live, only, busy, asking, said, editing, onEdit, onAsk, onTest, onActive, onDefault, onRemove, onRename }: {
  a: BrokerAccount;
  live: boolean;
  /** The only account there is: it is kept, so it can be switched off but not removed. */
  only: boolean;
  busy: string | null;
  asking: Asking;
  said: { ok: boolean; text: string } | null;
  editing: { id: number; name: string; description: string } | null;
  onEdit: (e: { id: number; name: string; description: string } | null) => void;
  onAsk: (a: Asking) => void;
  onTest: () => void;
  onActive: (on: boolean) => void;
  onDefault: () => void;
  onRemove: (code: string) => void;
  onRename: () => void;
}) {
  const waiting = busy !== null;
  const [code, setCode] = useState('');
  // Why the server will not remove it, said before anyone types a code; `only` covers a server that does not say.
  const kept = a.keptBecause ?? (only ? 'This is the only account, and the last one is kept. Deactivate it instead.' : null);
  const mine = (action: string) => busy === `${a.id}:${action}`;
  const ask = asking && asking.id === a.id ? asking.what : null;
  return (
    <li aria-label={a.name} className={cn('rounded-md border border-solid p-3', a.isDefault ? 'border-[#3fb95055]' : 'border-border', !a.active && 'opacity-80')}>
      {editing ? (
        <form aria-label={`edit ${a.name}`} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]" onSubmit={(e) => { e.preventDefault(); onRename(); }}>
          <label className={field}>Name
            <Input value={editing.name} maxLength={40} autoComplete="off" onChange={(e) => onEdit({ ...editing, name: e.target.value })} />
          </label>
          <label className={field}>Description
            <Input value={editing.description} maxLength={200} autoComplete="off" onChange={(e) => onEdit({ ...editing, description: e.target.value })} />
          </label>
          <div className="flex items-end gap-2">
            <Button type="submit" size="sm" disabled={waiting || editing.name.trim() === ''}>{mine('rename') ? 'Saving…' : 'Save'}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => onEdit(null)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <b className="text-[13.5px] text-foreground">{a.name}</b>
          {a.isDefault && <Badge tone="ok">Default · the desk trades on this</Badge>}
          {!a.active && <Badge>Off</Badge>}
          {!a.readable && <Badge tone="danger">Key unreadable</Badge>}
        </div>
      )}
      {!editing && a.description && <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">{a.description}</p>}
      <p className="m-0 mt-1 text-[11.5px] text-[var(--dim)]">
        Delta Exchange India · key <span className="font-mono text-muted-foreground">••••{a.keyHint}</span> · secret encrypted
      </p>
      <p aria-label="last connection test" className={cn('m-0 mt-0.5 text-[11.5px]', !a.lastTest ? 'text-[var(--dim)]' : a.lastTest.ok ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
        {!a.lastTest ? 'Connection not tested yet.' : `${a.lastTest.ok ? '✓' : '✗'} ${a.lastTest.detail} · tested ${ago(a.lastTest.at)}`}
      </p>
      {!a.readable && (
        <p className="m-0 mt-0.5 text-[11.5px] text-[var(--down)]">The server can no longer read this key (its master secret changed). Add it again as a new account, then remove this one.</p>
      )}

      {ask === 'remove' ? (
        <form role="group" aria-label={`remove ${a.name}?`} className="mt-2 grid max-w-sm gap-2 text-[12px]"
              onSubmit={(e) => { e.preventDefault(); if (code.length === 6 && !waiting) { onRemove(code); setCode(''); } }}>
          <span className="text-[var(--down)]">Remove "{a.name}" and its key for good? Enter the code from your authenticator app to confirm.</span>
          <CodeInput value={code} onChange={setCode} disabled={waiting} label={`authenticator code to remove ${a.name}`} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" className="bg-[var(--down)] text-white" disabled={waiting || code.length !== 6}>
              {mine('remove') ? 'Checking the code…' : 'Remove for good'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setCode(''); onAsk(null); }}>Keep it</Button>
          </div>
        </form>
      ) : ask === 'default' ? (
        <div role="group" aria-label={`trade on ${a.name}?`} className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-[var(--warn)]">The desk is LIVE. From this tap, real orders go to "{a.name}".</span>
          <Button type="button" size="sm" disabled={waiting} onClick={onDefault}>Yes, trade on it</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => onAsk(null)}>Cancel</Button>
        </div>
      ) : !editing && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" variant="outline" disabled={waiting || !a.readable} onClick={onTest}>
            <PlugZap size={13} aria-hidden /> {mine('test') ? 'Testing…' : 'Test connection'}
          </Button>
          {!a.isDefault && (
            <Button type="button" size="sm" variant="outline" disabled={waiting || !a.active || !a.readable}
                    title={!a.active ? 'Switch it on first' : undefined}
                    onClick={() => (live ? onAsk({ id: a.id, what: 'default' }) : onDefault())}>
              <Star size={13} aria-hidden /> {mine('default') ? 'Testing, then switching…' : 'Make default'}
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" disabled={waiting} aria-pressed={a.active} onClick={() => onActive(!a.active)}>
            <Check size={13} aria-hidden /> {a.active ? 'Deactivate' : 'Activate'}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={waiting} onClick={() => onEdit({ id: a.id, name: a.name, description: a.description })}>
            <Pencil size={13} aria-hidden /> Edit name
          </Button>
          <Button type="button" size="sm" variant="ghost" className="text-[var(--down)]" disabled={waiting || kept !== null}
                  title={kept ?? 'Asks for an authenticator code'}
                  onClick={() => onAsk({ id: a.id, what: 'remove' })}>
            <Trash2 size={13} aria-hidden /> Remove
          </Button>
          {kept && <span aria-label="why it is kept" className="text-[11px] text-muted-foreground">{kept}</span>}
        </div>
      )}
      {said && <p role={said.ok ? 'status' : 'alert'} className={cn('m-0 mt-1.5 text-[12px]', said.ok ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{said.text}</p>}
    </li>
  );
}
