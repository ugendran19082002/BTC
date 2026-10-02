import { getTelegramLog, type TelegramLogEntry } from '@/api/trade';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { LogTable } from '@/components/strategy/LogTable';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { stamp } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Every Telegram message the desk tried to send, and what became of it: sent, failed with Telegram's reason,
 * or held back as a repeat of the same words (2 Oct 2026, owner: "check the last Telegram alerts"). Until then
 * only failures were written down, in the error log, and "what did my phone get today?" had no answer.
 */

type Show = 'all' | TelegramLogEntry['status'];
const SHOW: { v: Show; label: string }[] = [
  { v: 'all', label: 'All' }, { v: 'sent', label: 'Sent' }, { v: 'failed', label: 'Failed' }, { v: 'repeat', label: 'Held back' },
];
const OUTCOME = { sent: 'sent', failed: 'failed', repeat: 'held back' } as const;

/** The message's words without its markup: the first line, then the rest. */
export function plainOf(html: string): { head: string; rest: string } {
  const text = html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const [head = '', ...rest] = text.split('\n').filter((l) => l.trim());
  return { head, rest: rest.join(' · ') };
}

export function TelegramLogCard() {
  const [show, setShow] = usePersisted<Show>('telegram-log:show', 'all');
  const { data, error } = usePoll(() => getTelegramLog(show === 'all' ? undefined : show), 15_000, { deps: [show] });
  const chip = (on: boolean) => cn('m-0 h-8 appearance-none rounded-md border border-solid px-2.5 font-[inherit] text-[12px]',
    on ? 'border-foreground bg-muted text-foreground' : 'border-border bg-transparent text-muted-foreground');

  return (
    <CollapsibleCard
      id="settings-telegram-log"
      title="Telegram — every message"
      ariaLabel="telegram log"
      right={data && (
        <span className={cn('text-[11px] font-semibold', !data.configured ? 'text-[var(--dim)]' : data.on ? 'text-[var(--up)]' : 'text-[var(--warn)]')}>
          {!data.configured ? 'not set up' : data.on ? 'alerts on' : 'alerts off'}
        </span>
      )}
    >
      <div role="group" aria-label="which messages" className="mb-2 flex flex-wrap gap-1">
        {SHOW.map((x) => (
          <button key={x.v} type="button" aria-pressed={show === x.v} onClick={() => setShow(x.v)} className={chip(show === x.v)}>{x.label}</button>
        ))}
      </div>
      {error && <p role="alert" className="m-0 mb-2 text-[12px] text-[var(--down)]">Could not read the log: {error.message}</p>}
      {data && data.entries.length === 0 ? (
        <p className="m-0 text-[12px] text-muted-foreground">Nothing yet{show === 'all' ? '' : ` ${OUTCOME[show].toLowerCase()}`} — messages are written here from this deploy on.</p>
      ) : (
        <LogTable
          label="telegram messages"
          rows={(data?.entries ?? []).map((e) => {
            const { head, rest } = plainOf(e.text);
            return {
              id: e.id,
              at: stamp(e.at),
              who: head,
              outcome: OUTCOME[e.status],
              tone: e.status === 'sent' ? 'ok' as const : e.status === 'failed' ? 'bad' as const : 'quiet' as const,
              detail: e.status === 'failed' && e.error ? `Telegram said: ${e.error}. ${rest}` : rest,
            };
          })}
        />
      )}
      <p className="m-0 mt-1.5 text-[10.5px] text-[var(--dim)]">
        Held back: the same words under the same alert inside 15 minutes are not sent again. Kept thirty days.
      </p>
    </CollapsibleCard>
  );
}
