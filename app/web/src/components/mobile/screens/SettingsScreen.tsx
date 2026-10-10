import { LogOut } from 'lucide-react';
import { HealthCard } from '@/components/mobile/HealthCard';
import { usePhoneData } from '@/components/mobile/phone-context';
import { Panel, Pill, Row, Rows } from '@/components/mobile/parts';
import { ago, stamp } from '@/lib/format';
import { DeskSwitch } from '@/components/mobile/DeskSwitch';

/**
 * Status and settings (6 Oct 2026): the desk's health in full, who is signed in and how, which build the server
 * runs, whether Telegram is set up, and signing out. Nothing here changes the desk: the switches live on the
 * desk itself, behind a full sign-in.
 */
export function SettingsScreen() {
  const p = usePhoneData();
  const b = p.glance?.build;
  const alerts = p.status?.alerts;
  return (
    <>
      <HealthCard glance={p.glance} error={p.glanceError} />

      <Panel title="This phone">
        <Rows>
          <Row label="Signed in as">{p.me.username ?? '—'}</Row>
          <Row label="Access">{p.me.scope === 'view' ? <Pill tone="dim">VIEW ONLY</Pill> : <Pill tone="accent">FULL</Pill>}</Row>
          {p.me.expiresAt ? <Row label="Signed in until">{stamp(p.me.expiresAt)}</Row> : null}
          <Row label="Last update">{p.statusAt !== null ? ago(p.statusAt, p.now) : '—'}</Row>
        </Rows>
        <p className="m-0 mt-2 text-[12.5px] text-muted-foreground">
          {p.me.scope === 'view'
            ? 'View only: the server refuses every change from this phone, even if it is lost. To trade, use the full desk.'
            : 'This phone is signed in with full access. The phone screens still change nothing.'}
          {' '}To install it as an app: the browser menu → <b>Install app</b> or <b>Add to Home screen</b>.
        </p>
      </Panel>

      <Panel title="Server">
        <Rows>
          <Row label="Build">{b?.tag ?? 'run by hand'}</Row>
          <Row label="Running since">{b ? `${stamp(b.startedAt)} (${ago(b.startedAt, p.now)})` : '—'}</Row>
          <Row label="Telegram alerts">
            {alerts ? (alerts.configured ? (alerts.on ? <Pill tone="up">ON</Pill> : <Pill tone="dim">OFF</Pill>) : <Pill tone="dim">NOT SET UP</Pill>) : '—'}
          </Row>
        </Rows>
      </Panel>

      <div className="flex flex-col gap-2">
        <DeskSwitch />
        <button
          type="button" onClick={p.signOut}
          className="flex h-12 items-center justify-center gap-2 rounded-lg border border-border bg-transparent font-[inherit] text-[15px] text-foreground active:bg-muted"
        >
          <LogOut className="h-5 w-5" aria-hidden="true" /> Sign out
        </button>
      </div>
    </>
  );
}
