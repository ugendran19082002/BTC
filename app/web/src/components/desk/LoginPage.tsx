import { useState, type FormEvent } from 'react';
import { login } from '@/api/session';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, Note } from '@/components/ui/card';

/**
 * The gate in front of the desk.
 *
 * The page behind this shows position sizing and, with a key configured, real
 * balances. It sits on the open internet, so it needs one.
 *
 * The form says as little as possible when it fails: whether the username
 * exists is not something a stranger should be able to learn by trying.
 */
export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-[380px] flex-col justify-center px-4">
      <div className="mb-5">
        <h1 className="m-0 text-[19px] font-semibold tracking-[-0.2px]">BTC Options Desk</h1>
        <p className="mt-1 mb-0 text-[12px] text-muted-foreground">
          Delta Exchange India · sign in to continue
        </p>
      </div>

      <Card>
        <CardTitle>Sign in</CardTitle>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[10.5px] uppercase tracking-[0.6px] text-[var(--dim)]">
              username
            </span>
            <input
              className="h-9 rounded-md border border-border bg-[var(--bg)] px-2.5 font-mono text-[13px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
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
            <span className="text-[10.5px] uppercase tracking-[0.6px] text-[var(--dim)]">
              password
            </span>
            <input
              type="password"
              className="h-9 rounded-md border border-border bg-[var(--bg)] px-2.5 font-mono text-[13px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          {error && (
            <div className="rounded-md border border-[#f8514955] bg-[#f8514915] px-3 py-2 text-[12.5px] text-[#ffb3ae]">
              {error}
            </div>
          )}

          <Button type="submit" disabled={busy} className="mt-1 h-9">
            {busy ? 'checking…' : 'Sign in'}
          </Button>
        </form>

        <Note tone="dim">
          Eight wrong attempts locks this address out for ten minutes. The session
          lasts a day, then asks again.
        </Note>
      </Card>
    </div>
  );
}
