import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { CalendarIcon, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { TimePicker } from '@/components/ui/time-picker';
import { time12 } from '@/lib/time';

import { type IstMoment } from '@/lib/ist-moment';

/**
 * A date and time, always read as India time -- see `lib/ist-moment.ts` for
 * why. The picker works in IST regardless of where the browser is.
 */
export { istToEpoch, nowIst, type IstMoment } from '@/lib/ist-moment';

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
        <Button variant="outline" className="w-[250px] justify-start font-mono">
          <CalendarIcon className="h-3.5 w-3.5 opacity-70" />
          {format(selected, 'd MMM yyyy')}
          <span className="opacity-50">·</span>
          {time12(value.time)}
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
          <TimePicker
            label="Time"
            value={value.time}
            onChange={(time) => onChange({ ...value, time })}
            presets={[
              { label: '5:30 AM · entry', value: ENTRY },
              { label: '5:29 PM · exit', value: SETTLE },
            ]}
            className="w-full"
          />
          {!atEntry && (
            <p className="mt-2 max-w-[248px] text-[11px] leading-relaxed text-muted-foreground">
              Every backtest number was measured entering at 5:30 AM IST. Another
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
