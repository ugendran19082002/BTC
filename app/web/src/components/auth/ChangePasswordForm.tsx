import { useState, type FormEvent } from 'react';
import { Check, Eye, EyeOff, X } from 'lucide-react';
import { AuthError, changePassword } from '@/api/session';
import { Button } from '@/components/ui/button';
import { CodeInput } from '@/components/auth/CodeInput';
import { cn } from '@/lib/utils';

/**
 * Change the password: the current one, the new one twice, and a fresh code.
 *
 * The code as well as the current password, because a phone left unlocked and
 * signed in should not be enough to lock its owner out. The rules are checked
 * as it is typed, the same ones the server applies, so the save does not fail
 * on something the form could have said.
 */

const MIN = 12;

export function ChangePasswordForm({ username, onChanged }: { username: string; onChanged?: (endedSessions: number) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const rules = [
    { ok: next.length >= MIN, text: `At least ${MIN} characters` },
    { ok: next.length > 0 && !next.toLowerCase().includes(username.toLowerCase()), text: 'Does not contain the username' },
    { ok: next.length > 0 && next !== current, text: 'Different from the current password' },
    { ok: next.length > 0 && next === confirm, text: 'Both new passwords match' },
  ];
  const ready = current.length > 0 && rules.every((r) => r.ok) && code.length === 6;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await changePassword({ current, next, code });
      setCurrent(''); setNext(''); setConfirm(''); setCode('');
      setDone(r.endedSessions > 0
        ? `Password changed. ${r.endedSessions} other device${r.endedSessions === 1 ? ' was' : 's were'} signed out.`
        : 'Password changed.');
      onChanged?.(r.endedSessions);
    } catch (err) {
      const e2 = err as AuthError;
      setError(e2.problems?.length ? e2.problems.join(' ') : e2.message);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const field = 'h-11 w-full rounded-md border border-solid border-border bg-[var(--bg)] px-3 pr-10 text-[16px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

  return (
    <form onSubmit={submit} aria-label="change password" className="flex flex-col gap-2.5">
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-muted-foreground">Current password</span>
        <input type={show ? 'text' : 'password'} value={current} onChange={(e) => setCurrent(e.target.value)}
               autoComplete="current-password" aria-label="current password" className={field} />
      </label>
      <label className="relative flex flex-col gap-1">
        <span className="text-[12px] text-muted-foreground">New password</span>
        <input type={show ? 'text' : 'password'} value={next} onChange={(e) => setNext(e.target.value)}
               autoComplete="new-password" aria-label="new password" className={field} />
        <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'hide passwords' : 'show passwords'}
                className="absolute bottom-0 right-0 m-0 flex h-11 w-10 appearance-none items-center justify-center border-0 bg-transparent p-0 text-muted-foreground">
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-muted-foreground">New password again</span>
        <input type={show ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)}
               autoComplete="new-password" aria-label="confirm new password" className={field} />
      </label>

      <ul aria-label="password rules" className="m-0 grid list-none gap-0.5 p-0 text-[12px]">
        {rules.map((r) => (
          <li key={r.text} className={cn('flex items-center gap-1.5', r.ok ? 'text-[var(--up)]' : 'text-muted-foreground')}>
            {r.ok ? <Check className="h-3.5 w-3.5" aria-label="met" /> : <X className="h-3.5 w-3.5" aria-label="not yet" />}
            {r.text}
          </li>
        ))}
      </ul>

      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-muted-foreground">Code from your authenticator app</span>
        <CodeInput value={code} onChange={setCode} disabled={busy} invalid={Boolean(error)} />
      </label>

      {error && <p role="alert" className="m-0 text-[12.5px] leading-snug text-[var(--down)]">{error}</p>}
      {done && <p role="status" className="m-0 text-[12.5px] leading-snug text-[var(--up)]">{done}</p>}

      <Button type="submit" className="h-11 text-[15px]" disabled={!ready || busy}>
        {busy ? 'Changing…' : 'Change password'}
      </Button>
      <p className="m-0 text-[11.5px] leading-snug text-[var(--dim)]">
        Every other signed-in device is signed out when the password changes.
      </p>
    </form>
  );
}
