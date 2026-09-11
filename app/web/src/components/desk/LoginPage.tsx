import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { AuthError, login, submitCode } from '@/api/session';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, Note } from '@/components/ui/card';
import { CodeInput } from '@/components/auth/CodeInput';

/**
 * The gate in front of the desk: a password, then the code from the
 * authenticator app. Both, every time.
 *
 * The page behind this can place real orders, and it sits on the open internet.
 * A password on its own opens nothing: the server only hands out a short-lived
 * step that accepts a code, and only the code opens the desk.
 *
 * The form says as little as possible when it fails: whether the username
 * exists is not something a stranger should be able to learn by trying.
 */
export function LoginPage({ onSignedIn, onNeedsSetup, startAtCode = false }: {
  onSignedIn: () => void;
  onNeedsSetup: () => void;
  /** The browser already passed the password step (a reload mid-sign-in). */
  startAtCode?: boolean;
}) {
  const [step, setStep] = useState<'password' | 'code'>(startAtCode ? 'code' : 'password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (step === 'code') codeRef.current?.focus(); }, [step, recovery]);

  async function sendPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await login(username, password);
      setPassword('');
      if (r.next === 'setup') onNeedsSetup();
      else setStep('code');
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(value = code) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitCode(value);
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
      setCode('');
      if (err instanceof AuthError && err.restart) {
        setStep('password');
        setRecovery(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-[380px] flex-col justify-center px-4">
      <div className="mb-5">
        <h1 className="m-0 text-[20px] font-semibold tracking-[-0.2px]">BTC Desk</h1>
        <p className="mt-1 mb-0 text-[13px] text-muted-foreground">Delta Exchange India</p>
      </div>

      <Card>
        {step === 'password' ? (
          <>
            <CardTitle>Sign in</CardTitle>
            <form onSubmit={sendPassword} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">Username</span>
                <input
                  className="h-11 rounded-md border border-border bg-[var(--bg)] px-3 text-[16px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                  required
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">Password</span>
                <input
                  type="password"
                  className="h-11 rounded-md border border-border bg-[var(--bg)] px-3 text-[16px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>

              {error && <ErrorBox text={error} />}

              <Button type="submit" disabled={busy} className="mt-1 h-11 text-[15px]">
                {busy ? 'Checking…' : 'Continue'}
              </Button>
            </form>
            <Note tone="dim">
              Next you will be asked for the 6-digit code from your authenticator app. Too many wrong tries block sign-in
              for up to 15 minutes. You stay signed in for 24 hours.
            </Note>
          </>
        ) : (
          <>
            <CardTitle>
              <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-[var(--up)]" /> Enter authenticator code</span>
            </CardTitle>
            <form
              onSubmit={(e) => { e.preventDefault(); void sendCode(); }}
              className="flex flex-col gap-3"
            >
              <p className="m-0 text-[13px] leading-snug text-muted-foreground">
                {recovery
                  ? 'Type one of the recovery codes you saved when you set up two-step sign-in. Each works once.'
                  : 'Open Google Authenticator and type the 6-digit code shown for BTC Desk.'}
              </p>
              <CodeInput
                ref={codeRef}
                value={code}
                onChange={setCode}
                onComplete={(c) => void sendCode(c)}
                allowRecovery={recovery}
                label={recovery ? 'recovery code' : 'authenticator code'}
                disabled={busy}
                invalid={Boolean(error)}
              />

              {error && <ErrorBox text={error} />}

              <Button type="submit" disabled={busy || (recovery ? code.length < 8 : code.length !== 6)} className="h-11 text-[15px]">
                {busy ? 'Verifying…' : 'Verify'}
              </Button>
              <div className="flex justify-between gap-3 text-[12.5px]">
                <button type="button" className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-muted-foreground underline underline-offset-2"
                        onClick={() => { setRecovery((v) => !v); setCode(''); setError(null); }}>
                  {recovery ? 'Use the authenticator code' : 'Use a recovery code'}
                </button>
                <button type="button" className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-muted-foreground underline underline-offset-2"
                        onClick={() => { setStep('password'); setCode(''); setError(null); setRecovery(false); }}>
                  Start again
                </button>
              </div>
            </form>
          </>
        )}
      </Card>
    </div>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div role="alert" className="rounded-md border border-[#f8514955] bg-[#f8514915] px-3 py-2 text-[12.5px] text-[#ffb3ae]">
      {text}
    </div>
  );
}
