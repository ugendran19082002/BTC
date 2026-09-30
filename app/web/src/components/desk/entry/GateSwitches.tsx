import { useState } from 'react';
import { Lock, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { usePoll } from '@/hooks/usePoll';
import { getEntryGates, setEntryGate } from '@/api/entry';
import { cn } from '@/lib/utils';
import type { EntryGateSetting } from '@/types/entry';

/**
 * The hard gates' on/off switches, for the whole entry section: both ways,
 * every panel, and the paper log's recorder.
 *
 * A gate switched off is still read and still shown ("✗ would refuse"); it
 * just stops making a read NO TRADE. Data fresh is locked on. Every setup is
 * logged with the gates that were off, and the record counts only those taken
 * with every gate on -- said here, where the switch is, so nobody turns R:R
 * off expecting the record to still describe the rules.
 */

const WHEN = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export function GateSwitches({ onChanged }: {
  /** Called after a switch lands, so the board is read again at once. */
  onChanged: () => void;
}) {
  const { data, refresh } = usePoll(() => getEntryGates(), 60_000);
  const [gates, setGates] = useState<EntryGateSetting[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = gates ?? data?.gates ?? [];
  const off = list.filter((g) => !g.enabled);

  const flip = async (g: EntryGateSetting, enabled: boolean) => {
    setBusy(g.key);
    setError(null);
    try {
      const r = await setEntryGate(g.key, enabled);
      setGates(r.gates);
      void refresh();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="hard gate switches"
                className={cn('inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px]',
                  off.length ? 'border-[var(--warn)] text-[var(--warn)]' : 'border-border text-muted-foreground')}>
          {off.length ? <ShieldAlert size={14} aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
          Hard gates · {off.length ? `${off.length} off` : 'all on'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[min(80vh,var(--radix-popover-content-available-height,80vh))] w-[min(92vw,360px)] overflow-y-auto overscroll-contain p-3 text-[12px]">
        <p className="m-0 mb-2 font-semibold">Hard gates</p>
        <p className="m-0 mb-2 text-[11.5px] leading-snug text-muted-foreground">
          Any gate that refuses makes a setup NO TRADE. Switched off, a gate is still read and shown, but refuses
          nothing. Setups logged while a gate is off are kept out of the paper record, so the record always describes
          the rules with every gate on.
        </p>
        {error ? <p role="alert" className="m-0 mb-2 text-[var(--down)]">{error}</p> : null}
        <ul className="m-0 list-none p-0">
          {list.map((g) => (
            <li key={g.key} className="border-t border-border first:border-t-0">
              {g.locked ? (
                <div className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <span className="flex items-center gap-1 text-[13px] font-medium">{g.label}<Lock size={12} aria-label="locked on" className="text-muted-foreground" /></span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">Always on. {g.locked}</span>
                  </div>
                </div>
              ) : (
                <Switch label={g.label} checked={g.enabled} className={cn(busy === g.key && 'opacity-50')}
                        description={g.changedAt ? `${g.enabled ? 'On' : 'Off'} since ${WHEN.format(g.changedAt)}` : 'On'}
                        onCheckedChange={(v) => { if (busy === null) void flip(g, v); }} />
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
