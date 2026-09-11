import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, KeyRound, LogOut, MonitorSmartphone, ShieldCheck, History } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { AuthError, getAccount, logout, newRecoveryCodes, signOutOthers, type Account } from '@/api/session';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ChangePasswordForm } from '@/components/auth/ChangePasswordForm';
import { CodeInput } from '@/components/auth/CodeInput';
import { RecoveryCodes } from '@/components/auth/TwoStepSetup';
import { ago, stamp } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The profile button in the header, and the account sheet behind it.
 *
 * Everything about who is signed in, in one place: change the password, see
 * the devices signed in and sign the others out, replace the recovery codes,
 * read what has happened to the account, sign out.
 */

const EVENT_TEXT: Record<string, string> = {
  password_ok: 'Password accepted',
  password_wrong: 'Wrong password',
  code_wrong: 'Wrong authenticator code',
  signin: 'Signed in',
  signin_recovery_code: 'Signed in with a recovery code',
  signin_locked: 'Sign-in locked',
  signout: 'Signed out',
  '2fa_enabled': 'Two-step sign-in turned on',
  '2fa_reset': 'Two-step sign-in reset on the server',
  password_changed: 'Password changed',
  password_change_wrong_password: 'Password change: wrong current password',
  password_change_wrong_code: 'Password change: wrong code',
  recovery_codes_replaced: 'New recovery codes made',
  signed_out_others: 'Other devices signed out',
  signed_out_all: 'All devices signed out on the server',
  user_created: 'Account created',
};

const BAD = new Set(['password_wrong', 'code_wrong', 'signin_locked', 'password_change_wrong_password', 'password_change_wrong_code', 'signin_recovery_code']);

export function ProfileMenu({ username, onSignedOut }: { username: string | null; onSignedOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getAccount().then((a) => { setAccount(a); setError(null); }).catch((e) => {
      if (e instanceof AuthError && e.status === 401) onSignedOut();
      else setError((e as Error).message);
    });
  }, [onSignedOut]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const name = account?.username ?? username ?? '';

  return (
    <>
      <button
        type="button"
        aria-label="Account"
        title="Account"
        onClick={() => setOpen(true)}
        className="m-0 flex h-9 w-9 flex-none appearance-none items-center justify-center rounded-full border border-solid border-border bg-muted p-0 font-[inherit] text-[14px] font-semibold uppercase text-foreground"
      >
        {name.slice(0, 1) || '?'}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent title={name || 'Account'} description={account ? `Signed in until ${stamp(account.sessionExpiresAt)}` : undefined}>
          {error && <p role="alert" className="m-0 mb-2 text-[12.5px] text-[var(--down)]">{error}</p>}

          <div className="mb-3 flex items-center gap-2 rounded-lg bg-muted px-3 py-2.5 text-[12.5px]">
            <ShieldCheck className="h-4 w-4 flex-none text-[var(--up)]" />
            <span className="text-foreground">
              Two-step sign-in {account?.twoFactorSince ? <>on since {stamp(account.twoFactorSince)}</> : 'on'}
            </span>
          </div>

          <Section title="Change password" icon={<KeyRound className="h-4 w-4" />} defaultOpen>
            <ChangePasswordForm username={name} onChanged={() => load()} />
            {account && <p className="m-0 mt-2 text-[11.5px] text-[var(--dim)]">Last changed {stamp(account.passwordChangedAt)}.</p>}
          </Section>

          <Section title={`Devices signed in${account ? ` · ${account.sessions.length}` : ''}`} icon={<MonitorSmartphone className="h-4 w-4" />}>
            <Devices account={account} onChanged={load} />
          </Section>

          <Section title={`Recovery codes${account ? ` · ${account.recoveryCodesLeft} left` : ''}`} icon={<KeyRound className="h-4 w-4" />}>
            <NewCodes onDone={load} />
          </Section>

          <Section title="Recent activity" icon={<History className="h-4 w-4" />}>
            {/* Its own scroll, so twenty events do not make the sheet a page long. */}
            <ul aria-label="recent activity" className="m-0 grid max-h-56 list-none gap-1 overflow-y-auto overscroll-contain p-0 pr-1 text-[12px]">
              {(account?.events ?? []).map((e) => (
                <li key={e.id} className="flex justify-between gap-3">
                  <span className={cn(BAD.has(e.kind) ? 'text-[var(--warn)]' : 'text-foreground')}>{EVENT_TEXT[e.kind] ?? e.kind}</span>
                  <span className="flex-none text-right text-[var(--dim)]">{ago(e.at)}{e.ip ? ` · ${e.ip}` : ''}</span>
                </li>
              ))}
            </ul>
            {(account?.events.length ?? 0) >= 20 && (
              <p className="m-0 mt-1 text-[11px] text-[var(--dim)]">The 20 most recent. Older ones are kept on the server for six months.</p>
            )}
          </Section>

          <Button
            variant="outline"
            className="mt-3 h-11 w-full text-[var(--down)]"
            onClick={() => { void logout().finally(() => { setOpen(false); onSignedOut(); }); }}
          >
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </SheetContent>
      </Sheet>
    </>
  );
}

function Section({ title, icon, children, defaultOpen = false }: {
  title: string; icon: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="border-t border-border py-1">
      <Collapsible.Trigger className="m-0 flex h-11 w-full appearance-none items-center gap-2 border-0 bg-transparent p-0 text-left font-[inherit] text-[13.5px] font-medium text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        <span className="flex-1">{title}</span>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </Collapsible.Trigger>
      <Collapsible.Content className="pb-3">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

function Devices({ account, onChanged }: { account: Account | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!account) return null;
  const others = account.sessions.filter((s) => !s.current).length;
  return (
    <div>
      <ul aria-label="devices" className="m-0 grid max-h-56 list-none gap-1.5 overflow-y-auto overscroll-contain p-0 pr-1">
        {account.sessions.map((s) => (
          <li key={s.id} className="rounded-md bg-muted px-2.5 py-2 text-[12.5px]">
            <div className="flex justify-between gap-2">
              <span className="font-medium text-foreground">{s.device}</span>
              {s.current && <span className="text-[11px] text-[var(--up)]">this device</span>}
            </div>
            <div className="text-[11.5px] text-muted-foreground">
              {s.ip ?? 'unknown address'} · signed in {ago(s.createdAt)} · active {ago(s.lastSeenAt)}
            </div>
          </li>
        ))}
      </ul>
      {others > 0 && (
        <Button variant="outline" className="mt-2 h-10 w-full" disabled={busy}
                onClick={() => { setBusy(true); void signOutOthers().then((r) => { setNote(`${r.ended} signed out.`); onChanged(); }).finally(() => setBusy(false)); }}>
          Sign out the other {others} device{others === 1 ? '' : 's'}
        </Button>
      )}
      {note && <p role="status" className="m-0 mt-1 text-[12px] text-[var(--up)]">{note}</p>}
    </div>
  );
}

function NewCodes({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (codes) {
    return (
      <div>
        <p className="m-0 mb-2 text-[12.5px] text-muted-foreground">The old codes no longer work. Save these; they are not shown again.</p>
        <RecoveryCodes codes={codes} />
      </div>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        void newRecoveryCodes(code).then((r) => { setCodes(r.recoveryCodes); onDone(); })
          .catch((err) => { setError((err as Error).message); setCode(''); })
          .finally(() => setBusy(false));
      }}
      className="flex flex-col gap-2"
    >
      <p className="m-0 text-[12.5px] leading-snug text-muted-foreground">
        Make ten new codes, for when the old ones are used up or may have been seen. Enter a code from your app to confirm.
      </p>
      <CodeInput value={code} onChange={setCode} disabled={busy} invalid={Boolean(error)} label="code to make new recovery codes" />
      {error && <p role="alert" className="m-0 text-[12.5px] text-[var(--down)]">{error}</p>}
      <Button type="submit" variant="outline" className="h-10" disabled={busy || code.length !== 6}>Make new recovery codes</Button>
    </form>
  );
}
