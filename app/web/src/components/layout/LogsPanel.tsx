import { AlertTriangle, Gauge, Send } from 'lucide-react';
import { ErrorLogPanel } from '@/components/layout/ErrorLogPanel';
import { TelegramLogCard } from '@/components/desk/TelegramLogCard';
import { DeskMetricsCard } from '@/components/desk/DeskMetricsCard';
import { usePersisted } from '@/hooks/usePersisted';
import { cn } from '@/lib/utils';

/**
 * The desk's logs in one screen: what went wrong, what was sent to the phone,
 * and how fast the desk is running. They were three places -- the Errors screen,
 * and two cards at the foot of Settings -- and Settings itself went on 4 Oct
 * 2026, so they are tabs here.
 */
const LOG_TABS = [
  { id: 'errors', label: 'Errors', Icon: AlertTriangle },
  { id: 'telegram', label: 'Telegram', Icon: Send },
  { id: 'speed', label: 'Speed', Icon: Gauge },
] as const;
type LogTab = (typeof LOG_TABS)[number]['id'];

export function LogsPanel() {
  const [saved, setTab] = usePersisted<LogTab>('logs:tab', 'errors');
  const tab: LogTab = LOG_TABS.some((t) => t.id === saved) ? saved : 'errors';
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <div role="tablist" aria-label="Logs" className="inline-flex w-fit max-w-full overflow-x-auto rounded-lg border border-solid border-border bg-[var(--panel)] p-1">
        {LOG_TABS.map(({ id, label, Icon }) => (
          <button
            key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn('m-0 inline-flex h-9 appearance-none items-center gap-1.5 rounded-md border-0 px-3 font-[inherit] text-[12.5px]',
              tab === id ? 'bg-[#2563eb] font-semibold text-white' : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground')}
          >
            <Icon size={14} aria-hidden /> {label}
          </button>
        ))}
      </div>
      {tab === 'errors' ? <ErrorLogPanel /> : tab === 'telegram' ? <TelegramLogCard /> : <DeskMetricsCard />}
    </div>
  );
}
