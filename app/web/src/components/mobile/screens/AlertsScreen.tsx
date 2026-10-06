import { AlertOctagon, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { getTelegramLog } from '@/api/phone';
import { usePoll } from '@/hooks/usePoll';
import { stamp } from '@/lib/format';
import { phoneAlerts } from '@/lib/phone-alerts';
import { cn } from '@/lib/utils';
import { usePhone } from '@/components/mobile/phone-context';
import { Empty, ListButton, Loading, Panel, Pill } from '@/components/mobile/parts';

/**
 * Alerts (6 Oct 2026): what needs a look right now, worked out from the live figures (lib/phone-alerts.ts), and
 * what the desk has said on Telegram -- fills, exits, problems -- with whether each message got through.
 */

const ICON = { red: AlertOctagon, amber: AlertTriangle, green: CheckCircle2 } as const;
const TONE = { red: 'text-[var(--down)]', amber: 'text-[var(--warn)]', green: 'text-[var(--up)]' } as const;

/** Telegram's HTML as plain text: tags out, entities back, a link kept as "text: url". */
export const textOf = (html: string) => html
  .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2: $1')
  .replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

export function AlertsScreen() {
  const p = usePhone();
  const alerts = phoneAlerts(p.status, p.glance, p.perp);
  const log = usePoll(() => getTelegramLog(30), 30_000);

  return (
    <>
      <Panel title={`Now · ${alerts.length}`}>
        {alerts.length === 0 ? <Empty>Nothing needs a look.</Empty> : (
          <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0" aria-label="Alerts now">
            {alerts.map((a, i) => {
              const Icon = ICON[a.level];
              const body = (
                <span className="flex gap-2.5">
                  <Icon aria-hidden="true" className={cn('mt-0.5 h-5 w-5 shrink-0', TONE[a.level])} />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium">{a.title}</span>
                    {a.detail && <span className="block text-[12.5px] text-muted-foreground">{a.detail}</span>}
                  </span>
                </span>
              );
              return (
                <li key={`${a.title}-${a.tradeId ?? ''}-${i}`}>
                  {a.tradeId ? <ListButton onClick={() => p.openTrade(a.tradeId!)} label={`${a.title}: open the trade`}>{body}</ListButton> : <div className="py-2.5">{body}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="Telegram"
        right={log.data ? (log.data.configured ? (log.data.on ? <Pill tone="up">ON</Pill> : <Pill tone="dim">OFF</Pill>) : <Pill tone="dim">NOT SET UP</Pill>) : undefined}
      >
        {!log.data ? <Loading error={log.error} what="the Telegram log" /> : log.data.entries.length === 0 ? <Empty>No message sent yet.</Empty> : (
          <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0" aria-label="Telegram messages">
            {log.data.entries.map((e) => {
              const text = textOf(e.text);
              const [first, ...rest] = text.split('\n').filter((l) => l.trim());
              return (
                <li key={e.id} className="py-2">
                  <details>
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block text-[14px] font-medium">{first}</span>
                        <span className="block text-[12px] text-muted-foreground">{stamp(e.at)}{e.error ? ` · ${e.error}` : ''}</span>
                      </span>
                      {e.status === 'sent' ? <Pill tone="up">SENT</Pill> : e.status === 'failed' ? <Pill tone="down">FAILED</Pill> : <Pill tone="dim">REPEAT</Pill>}
                    </summary>
                    {rest.length > 0 && <pre className="m-0 mt-1.5 whitespace-pre-wrap break-words font-[inherit] text-[12.5px] leading-snug text-muted-foreground">{rest.join('\n')}</pre>}
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
