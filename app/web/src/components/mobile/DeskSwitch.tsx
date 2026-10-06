import { useState } from 'react';
import { Monitor } from 'lucide-react';
import { logout } from '@/api/session';
import { usePhone } from '@/components/mobile/phone-context';

/**
 * From the phone to the full desk (6 Oct 2026). With a full sign-in, straight there. With a view-only one the desk
 * would refuse everything it offers -- it can trade, so it needs a full sign-in -- so this says so in one line and
 * offers the way: sign out here, then sign in on the desk. Never a way round the sign-in.
 */
export function DeskSwitch() {
  const p = usePhone();
  const [asking, setAsking] = useState(false);
  const full = p.me.scope !== 'view';

  if (asking) {
    return (
      <div role="dialog" aria-label="Switch to desk view" className="rounded-lg border border-border bg-background p-3.5">
        <p className="m-0 text-[14px] leading-snug">
          The full desk can place and close orders, so it needs a full sign-in. This phone is signed in <b>view only</b>.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setAsking(false)} className="h-11 rounded-md border border-border bg-transparent font-[inherit] text-[14px] text-foreground">
            Stay here
          </button>
          <button
            type="button"
            onClick={async () => { await logout().catch(() => undefined); window.location.assign('/'); }}
            className="h-11 rounded-md border-0 bg-[var(--up)] font-[inherit] text-[14px] font-semibold text-[var(--bg)]"
          >
            Sign in to the desk
          </button>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => (full ? window.location.assign('/') : setAsking(true))}
      className="flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-border bg-transparent font-[inherit] text-[15px] text-foreground active:bg-muted"
    >
      <Monitor className="h-5 w-5" aria-hidden="true" /> Switch to desk view
    </button>
  );
}
