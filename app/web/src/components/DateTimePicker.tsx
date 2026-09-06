import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { CalendarIcon, Clock } from 'lucide-react';
import { Button } from './ui/button';
import { Calendar } from './ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

/**
 * A date and time, always read as India time.
 *
 * The strategy is defined in IST -- entry 05:30, settlement 17:30 -- so the
 * picker works in IST regardless of where the browser is. Anything else makes
 * "05:30" mean different moments to different viewers, which is the one thing
 * this control must never do.
 */
export type IstMoment = { date: string; time: string };

/** Epoch seconds for an IST wall-clock moment. */
export function istToEpoch({ date, time }: IstMoment): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!, hh!, mm!) / 1000) - 5.5 * 3600;
}

export function nowIst(): IstMoment {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}

const ENTRY = '05:30';
const SETTLE = '17:29';

export function DateTimePicker({
  value,
  onChange,
  minDate,
  maxDate,
}: {
  value: IstMoment;
  onChange: (v: IstMoment) => void;
  minDate?: Date;
  maxDate?: Date;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseISO(value.date);
  const atEntry = value.time === ENTRY;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-[230px] justify-start font-mono">
          <CalendarIcon className="h-3.5 w-3.5 opacity-70" />
          {format(selected, 'd MMM yyyy')}
          <span className="opacity-50">·</span>
          {value.time}
          <span className="ml-auto text-[10px] opacity-50">IST</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-auto">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          disabled={[
            ...(minDate ? [{ before: minDate }] : []),
            ...(maxDate ? [{ after: maxDate }] : []),
          ]}
          onSelect={(d) => {
            if (!d) return;
            onChange({ ...value, date: format(d, 'yyyy-MM-dd') });
          }}
        />

        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <Clock className="h-3 w-3" />
            time (IST)
          </div>
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={value.time}
              onChange={(e) => onChange({ ...value, time: e.target.value })}
              className="h-8 rounded-md border border-border bg-[var(--bg)] px-2 font-mono text-[13px] text-foreground"
            />
            <Button
              size="sm"
              variant={atEntry ? 'default' : 'outline'}
              onClick={() => onChange({ ...value, time: ENTRY })}
              title="The moment the strategy enters"
            >
              05:30 entry
            </Button>
            <Button
              size="sm"
              variant={value.time === SETTLE ? 'default' : 'outline'}
              onClick={() => onChange({ ...value, time: SETTLE })}
              title="One minute before settlement"
            >
              17:29 exit
            </Button>
          </div>
          {!atEntry && (
            <p className="mt-2 max-w-[248px] text-[11px] leading-relaxed text-muted-foreground">
              Every backtest number was measured entering at 05:30 IST. Another
              time shows you the chain, but not a comparable trade.
            </p>
          )}
        </div>

        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={() => setOpen(false)}>Done</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
