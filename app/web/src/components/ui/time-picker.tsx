import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Clock, Minus, Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import {
  fromParts, hhmmOf, inRange, isHhmm, minutesOf, parseTyped, partsOf, time12, type Period,
} from '@/lib/time';

/**
 * A time of day, picked on a clock face.
 *
 * A bare "HH:MM" text box makes it easy to mean 5:29 PM and type 05:29, and
 * nothing on screen says which one was saved. So the value is chosen the way a
 * time is read -- hour on a dial, then the minute, then AM or PM -- and it is
 * always shown back as "5:29 PM".
 *
 * Value in and out is 24-hour "HH:MM", the form the server stores. `min` and
 * `max` are inclusive: anything outside them cannot be picked, and the dial
 * greys out the hours and minutes that would land there.
 *
 * On a phone it opens as a sheet from the bottom, not a popover. A popover
 * above a field low on a 360x800 screen had no room: its top -- the label and
 * AM -- went under the browser's address bar, on the live desk, 11 September.
 * The sheet always has the height, and the Set button lands under the thumb.
 * On a wider screen it is a popover, held to the space the screen has.
 *
 * The field and the Set button are 44px tall, and there is a text field inside
 * for anybody faster with a keyboard.
 */

type Mode = 'hour' | 'minute';

const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const DIAL = 212;
const RADIUS = 84;

export function TimePicker({
  value, onChange, label, min, max, presets, invalid, className, disabled,
}: {
  value: string;
  onChange: (hhmm: string) => void;
  /** What the time is for: "Entry time". Read by screen readers and shown in the picker. */
  label: string;
  min?: string | null;
  max?: string | null;
  presets?: { label: string; value: string }[];
  invalid?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Phones get a bottom sheet; see the note above.
  const phone = useMediaQuery('(max-width: 639px)');
  const [draft, setDraft] = useState(isHhmm(value) ? value : '05:30');
  const [mode, setMode] = useState<Mode>('hour');
  const [typed, setTyped] = useState('');

  // Every opening starts from what is saved, on the hour.
  useEffect(() => {
    if (!open) return;
    setDraft(isHhmm(value) ? value : (min && isHhmm(min) ? min : '05:30'));
    setMode('hour');
    setTyped('');
  }, [open, value, min]);

  const { hour, minute, period } = partsOf(draft);
  const ok = inRange(draft, min, max);
  const allowed = (hhmm: string) => inRange(hhmm, min, max);

  /** The nearest allowed minute within one hour, or null when the hour has none. */
  const clampWithinHour = (h: number, p: Period, wantMinute: number): string | null => {
    const base = minutesOf(fromParts(h, 0, p));
    const want = base + wantMinute;
    let best: number | null = null;
    for (let m = 0; m < 60; m++) {
      if (!allowed(hhmmOf(base + m))) continue;
      if (best === null || Math.abs(base + m - want) < Math.abs(best - want)) best = base + m;
    }
    return best === null ? null : hhmmOf(best);
  };

  const hourAllowed = (h: number, p: Period) => clampWithinHour(h, p, 0) !== null;
  const periodAllowed = (p: Period) => HOURS.some((h) => hourAllowed(h, p));

  const pickHour = (h: number) => {
    const next = clampWithinHour(h, period, minute);
    if (!next) return;
    setDraft(next);
    setMode('minute');
  };
  const pickMinute = (m: number) => {
    const next = fromParts(hour, m, period);
    if (allowed(next)) setDraft(next);
  };
  const pickPeriod = (p: Period) => {
    if (p === period) return;
    const direct = fromParts(hour, minute, p);
    if (allowed(direct)) { setDraft(direct); return; }
    // The same hour in the other half is out of range: the nearest time that is in.
    const all = Array.from({ length: 720 }, (_, i) => minutesOf(fromParts(12, 0, p)) + i);
    const target = minutesOf(direct);
    const inside = all.filter((x) => allowed(hhmmOf(x)));
    if (inside.length === 0) return;
    setDraft(hhmmOf(inside.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))));
  };
  const nudge = (by: number) => {
    const next = hhmmOf(minutesOf(draft) + by);
    if (allowed(next)) setDraft(next);
  };
  const applyTyped = () => {
    const parsed = parseTyped(typed);
    if (parsed && allowed(parsed)) { setDraft(parsed); setTyped(''); }
  };
  const typedProblem = typed.trim() === '' ? null
    : parseTyped(typed) === null ? 'Not a time — try 5:29 PM'
      : !allowed(parseTyped(typed)!) ? `Outside ${rangeText(min, max)}`
        : null;

  const commit = () => {
    if (!ok) return;
    onChange(draft);
    setOpen(false);
  };

  // Where the hand points: by the hour, or by the exact minute.
  const angle = mode === 'hour' ? (hour % 12) * 30 : minute * 6;
  const hand = polar(angle, RADIUS);
  const options = mode === 'hour' ? HOURS : MINUTES;

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      aria-label={`${label}: ${isHhmm(value) ? time12(value) : 'not set'}`}
      aria-invalid={invalid || undefined}
      className={cn(
        'm-0 inline-flex h-11 min-w-[128px] appearance-none items-center gap-2 rounded-md border border-solid bg-muted px-3',
        'font-[inherit] text-[15px] font-semibold tabular-nums text-foreground',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
        invalid ? 'border-[var(--down)]' : 'border-border',
        className,
      )}
    >
      <Clock className={cn('h-4 w-4 flex-none', invalid ? 'text-[var(--down)]' : 'text-muted-foreground')} />
      <span>{isHhmm(value) ? time12(value) : 'Pick a time'}</span>
      <span className="ml-auto text-[10px] font-normal text-[var(--dim)]">IST</span>
    </button>
  );

  const face = (
    <div>
      <p className="m-0 mb-2 text-[11px] uppercase tracking-[0.6px] text-muted-foreground">{label}</p>

      {/* The time as it reads, each part a way back to changing it. */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-0.5 font-semibold tabular-nums">
          <Segment active={mode === 'hour'} onClick={() => setMode('hour')} label="change hour">
            {String(hour).padStart(2, ' ')}
          </Segment>
          <span className="text-[26px] text-muted-foreground">:</span>
          <Segment active={mode === 'minute'} onClick={() => setMode('minute')} label="change minute">
            {String(minute).padStart(2, '0')}
          </Segment>
        </div>
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="AM or PM">
          {(['AM', 'PM'] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={period === p}
              disabled={!periodAllowed(p)}
              onClick={() => pickPeriod(p)}
              className={cn(
                'm-0 h-8 w-14 appearance-none rounded-md border border-solid font-[inherit] text-[13px] font-semibold',
                'disabled:cursor-not-allowed disabled:opacity-35',
                period === p
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-black'
                  : 'border-border bg-transparent text-muted-foreground',
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* The dial. */}
      <div
        className="relative mx-auto rounded-full bg-muted"
        style={{ width: DIAL, height: DIAL }}
        role="group"
        aria-label={mode === 'hour' ? 'hours' : 'minutes'}
      >
        <svg className="pointer-events-none absolute inset-0" width={DIAL} height={DIAL} aria-hidden>
          <line x1={DIAL / 2} y1={DIAL / 2} x2={DIAL / 2 + hand.x} y2={DIAL / 2 + hand.y}
                stroke="var(--accent)" strokeWidth={2} />
          <circle cx={DIAL / 2} cy={DIAL / 2} r={3} fill="var(--accent)" />
        </svg>
        {options.map((n, i) => {
          const p = polar(i * 30, RADIUS);
          const selected = mode === 'hour' ? n === hour : n === minute;
          const can = mode === 'hour' ? hourAllowed(n, period) : allowed(fromParts(hour, n, period));
          return (
            <button
              key={n}
              type="button"
              aria-pressed={selected}
              aria-label={mode === 'hour' ? `${n} o'clock` : `${n} minutes`}
              disabled={!can}
              onClick={() => (mode === 'hour' ? pickHour(n) : pickMinute(n))}
              className={cn(
                'absolute m-0 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 appearance-none items-center justify-center rounded-full border-0',
                'font-[inherit] text-[13.5px] tabular-nums transition-colors',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-25',
                selected ? 'bg-[var(--accent)] font-semibold text-black' : 'bg-transparent text-foreground hover:bg-background',
              )}
              style={{ left: DIAL / 2 + p.x, top: DIAL / 2 + p.y }}
            >
              {mode === 'hour' ? n : String(n).padStart(2, '0')}
            </button>
          );
        })}
      </div>

      {/* The exact minute -- 5:29 is not on a five-minute dial. */}
      <div className="mt-2 flex items-center justify-center gap-2">
        <NudgeButton label="one minute earlier" disabled={!allowed(hhmmOf(minutesOf(draft) - 1))} onClick={() => nudge(-1)}>
          <Minus className="h-3.5 w-3.5" /> 1 min
        </NudgeButton>
        <NudgeButton label="one minute later" disabled={!allowed(hhmmOf(minutesOf(draft) + 1))} onClick={() => nudge(1)}>
          <Plus className="h-3.5 w-3.5" /> 1 min
        </NudgeButton>
      </div>

      {presets && presets.length > 0 && (
        <div className="mt-2 flex flex-wrap justify-center gap-1.5">
          {presets.map((p) => (
            <button
              key={p.value + p.label}
              type="button"
              disabled={!allowed(p.value)}
              onClick={() => setDraft(p.value)}
              aria-pressed={draft === p.value}
              className={cn(
                'm-0 h-8 appearance-none rounded-full border border-solid px-2.5 font-[inherit] text-[12px]',
                'disabled:cursor-not-allowed disabled:opacity-35',
                draft === p.value ? 'border-[var(--accent)] text-foreground' : 'border-border bg-transparent text-muted-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-2">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyTyped(); } }}
          onBlur={applyTyped}
          aria-label={`type the ${label.toLowerCase()}`}
          placeholder="or type, e.g. 5:29 PM"
          inputMode="text"
          className="h-9 w-full rounded-md border border-solid border-border bg-muted px-2.5 font-[inherit] text-[13px] text-foreground outline-none placeholder:text-[var(--dim)] focus-visible:border-[var(--accent)]"
        />
        {typedProblem && <p className="m-0 mt-1 text-[11.5px] text-[var(--down)]">{typedProblem}</p>}
      </div>

      {(min || max) && (
        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
          Allowed: {rangeText(min, max)}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="m-0 h-11 flex-none appearance-none rounded-md border border-solid border-border bg-muted px-4 font-[inherit] text-[13px] text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!ok}
          onClick={commit}
          className="m-0 h-11 flex-1 appearance-none rounded-md border-0 bg-primary font-[inherit] text-[13.5px] font-semibold text-primary-foreground disabled:opacity-50"
        >
          Set {time12(draft)}
        </button>
      </div>
    </div>
  );

  if (phone) {
    return (
      <Dialog.Root open={open} onOpenChange={(v) => !disabled && setOpen(v)}>
        <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
          <Dialog.Content
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => e.preventDefault()}
            className={cn(
              'fixed inset-x-0 bottom-0 z-[60] max-h-[92dvh] overflow-y-auto rounded-t-2xl border border-border bg-popover',
              'px-4 pt-2 pb-[calc(12px+env(safe-area-inset-bottom))] text-popover-foreground focus:outline-none',
            )}
          >
            <div aria-hidden className="mx-auto mb-2 h-1 w-9 rounded-full bg-[var(--line)]" />
            <Dialog.Title className="sr-only">{`${label} picker`}</Dialog.Title>
            <div className="mx-auto max-w-[340px]">{face}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <Popover open={open} onOpenChange={(v) => !disabled && setOpen(v)}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        className="w-[292px] overflow-y-auto p-3"
        style={{ maxHeight: 'var(--radix-popover-content-available-height)' }}
        collisionPadding={12}
        aria-label={`${label} picker`}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {face}
      </PopoverContent>
    </Popover>
  );
}

function Segment({ active, onClick, label, children }: {
  active: boolean; onClick: () => void; label: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'm-0 min-w-[52px] appearance-none rounded-md border-0 px-1.5 py-0.5 font-[inherit] text-[30px] leading-tight',
        active ? 'bg-muted text-[var(--accent)]' : 'bg-transparent text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function NudgeButton({ label, disabled, onClick, children }: {
  label: string; disabled: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="m-0 inline-flex h-8 appearance-none items-center gap-1 rounded-md border border-solid border-border bg-transparent px-2.5 font-[inherit] text-[12px] text-muted-foreground disabled:opacity-35"
    >
      {children}
    </button>
  );
}

/** 0 degrees is twelve o'clock, clockwise. */
function polar(deg: number, r: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: Math.cos(rad) * r, y: Math.sin(rad) * r };
}

function rangeText(min?: string | null, max?: string | null): string {
  // A range that ends earlier than it starts runs past midnight, and saying so
  // is the difference between "5:29 PM" reading as impossible and as tomorrow.
  if (min && max) {
    return isHhmm(min) && isHhmm(max) && minutesOf(max) < minutesOf(min)
      ? `${time12(min)} to ${time12(max)} the next day`
      : `${time12(min)} to ${time12(max)}`;
  }
  if (min) return `${time12(min)} or later`;
  if (max) return `${time12(max)} or earlier`;
  return 'any time';
}
