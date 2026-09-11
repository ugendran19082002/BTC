import { useEffect, useRef, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { AuthError, enableTwoStep, getSetup } from '@/api/session';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { CodeInput } from '@/components/auth/CodeInput';
import { cn } from '@/lib/utils';

/**
 * First sign-in: turning on two-step sign-in. It cannot be skipped.
 *
 *   1. Scan      the QR code with Google Authenticator (or type the key)
 *   2. Verify    the 6-digit code the app now shows
 *   3. Save      the ten recovery codes, the way in if the phone is lost
 *
 * The desk opens only after step 3 is acknowledged: codes that were never saved
 * are not a way back in.
 */
export function TwoStepSetup({ onDone, onRestart }: { onDone: () => void; onRestart: () => void }) {
  const [step, setStep] = useState<'scan' | 'verify' | 'codes'>('scan');
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getSetup()
      .then((s) => setSetup({ secret: s.secret, qrSvg: s.qrSvg }))
      .catch((e) => {
        if (e instanceof AuthError && e.restart) onRestart();
        else setLoadError((e as Error).message);
      });
  }, [onRestart]);

  useEffect(() => { if (step === 'verify') codeRef.current?.focus(); }, [step]);

  async function verify(value = code) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await enableTwoStep(value);
      setCodes(r.recoveryCodes);
      setStep('codes');
    } catch (e) {
      if (e instanceof AuthError && e.restart) { onRestart(); return; }
      setError((e as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-[420px] flex-col justify-center px-4 py-6">
      <div className="mb-4">
        <h1 className="m-0 flex items-center gap-2 text-[20px] font-semibold tracking-[-0.2px]">
          <ShieldCheck className="h-5 w-5 text-[var(--up)]" /> Security setup
        </h1>
        <p className="mt-1 mb-0 text-[13px] text-muted-foreground">
          Two-step sign-in is required. After this, every sign-in asks for your password and a code from your phone.
        </p>
      </div>

      <ol aria-label="setup steps" className="m-0 mb-3 flex list-none gap-1.5 p-0">
        {(['scan', 'verify', 'codes'] as const).map((s, i) => {
          const at = ['scan', 'verify', 'codes'].indexOf(step);
          return (
            <li key={s} aria-current={step === s ? 'step' : undefined}
                className={cn('h-1.5 flex-1 rounded-full', i <= at ? 'bg-[var(--accent)]' : 'bg-[var(--line)]')} />
          );
        })}
      </ol>

      <Card>
        {step === 'scan' && (
          <>
            <CardTitle>1 · Scan with Google Authenticator</CardTitle>
            <p className="m-0 mb-3 flex items-start gap-2 text-[13px] leading-snug text-muted-foreground">
              <Smartphone className="mt-0.5 h-4 w-4 flex-none" />
              Install Google Authenticator (or Microsoft Authenticator, Authy, 1Password). Tap “+”, then “Scan a QR code”.
            </p>
            {loadError ? (
              <p role="alert" className="m-0 text-[13px] text-[var(--down)]">{loadError}</p>
            ) : !setup ? (
              <div className="flex h-[232px] items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <>
                <div className="mx-auto w-[216px] rounded-lg bg-white p-2">
                  <img
                    alt="QR code to scan with your authenticator app"
                    src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`}
                    width={200}
                    height={200}
                    className="block h-[200px] w-[200px]"
                  />
                </div>
                <ManualKey secret={setup.secret} />
              </>
            )}
            <Button className="mt-3 h-11 w-full text-[15px]" disabled={!setup} onClick={() => setStep('verify')}>
              I have scanned it
            </Button>
          </>
        )}

        {step === 'verify' && (
          <form onSubmit={(e) => { e.preventDefault(); void verify(); }} className="flex flex-col gap-3">
            <CardTitle>2 · Enter the code it shows</CardTitle>
            <p className="m-0 text-[13px] leading-snug text-muted-foreground">
              The app now shows a 6-digit code for BTC Desk that changes every 30 seconds. Type the current one.
            </p>
            <CodeInput ref={codeRef} value={code} onChange={setCode} onComplete={(c) => void verify(c)} disabled={busy} invalid={Boolean(error)} />
            {error && <p role="alert" className="m-0 text-[12.5px] leading-snug text-[var(--down)]">{error}</p>}
            <Button type="submit" className="h-11 text-[15px]" disabled={busy || code.length !== 6}>
              {busy ? 'Verifying…' : 'Verify'}
            </Button>
            <button type="button" onClick={() => { setStep('scan'); setError(null); }}
                    className="m-0 appearance-none self-start border-0 bg-transparent p-0 font-[inherit] text-[12.5px] text-muted-foreground underline underline-offset-2">
              Back to the QR code
            </button>
          </form>
        )}

        {step === 'codes' && (
          <>
            <CardTitle>
              <span className="inline-flex items-center gap-1.5"><Check className="h-4 w-4 text-[var(--up)]" /> Two-step sign-in is on</span>
            </CardTitle>
            <p className="m-0 mb-2 flex items-start gap-2 text-[13px] leading-snug text-muted-foreground">
              <KeyRound className="mt-0.5 h-4 w-4 flex-none" />
              3 · Save these recovery codes somewhere safe, away from this phone. If the phone is lost, one of them signs you
              in. Each works once. They are not shown again.
            </p>
            <RecoveryCodes codes={codes} />
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-[13px] text-foreground">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5 h-4 w-4" />
              I have saved these recovery codes
            </label>
            <Button className="mt-3 h-11 w-full text-[15px]" disabled={!saved} onClick={onDone}>
              Open the desk
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}

/** The key, for an app that cannot scan: grouped in fours, and one tap to copy. */
function ManualKey({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="mt-3 rounded-md bg-muted px-3 py-2">
      <summary className="cursor-pointer text-[12.5px] text-muted-foreground">Can’t scan? Enter this key instead</summary>
      <div className="mt-2 flex items-center justify-between gap-2">
        <code aria-label="setup key" className="break-all font-mono text-[13px] leading-relaxed text-foreground">
          {secret.replace(/(.{4})/g, '$1 ').trim()}
        </code>
        <Button type="button" size="sm" variant="outline" className="h-9 flex-none"
                onClick={() => { void navigator.clipboard?.writeText(secret).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="m-0 mt-1 text-[11.5px] text-[var(--dim)]">Account: BTC Desk · Type: time-based</p>
    </details>
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <ul aria-label="recovery codes" className="m-0 grid list-none grid-cols-2 gap-1.5 rounded-md bg-muted p-3 font-mono text-[14px] tabular-nums">
        {codes.map((c) => <li key={c} className="text-center text-foreground">{c}</li>)}
      </ul>
      <Button type="button" size="sm" variant="outline" className="mt-2 h-9"
              onClick={() => { void navigator.clipboard?.writeText(codes.join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Copied' : 'Copy all'}
      </Button>
    </div>
  );
}
