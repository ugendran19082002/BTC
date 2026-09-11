import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * The 6-digit code from the authenticator app.
 *
 * One field, not six boxes: six boxes break paste, break the phone's own
 * "fill code" suggestion (autocomplete="one-time-code"), and break screen
 * readers. Spaced digits and a numeric keypad give the same look without that.
 * With `allowRecovery`, letters are allowed too, for a recovery code.
 */
export const CodeInput = forwardRef<HTMLInputElement, {
  value: string;
  onChange: (v: string) => void;
  /** Called once when six digits are in -- so a pasted code signs in without another tap. */
  onComplete?: (code: string) => void;
  allowRecovery?: boolean;
  label?: string;
  disabled?: boolean;
  invalid?: boolean;
}>(({ value, onChange, onComplete, allowRecovery, label = 'authenticator code', disabled, invalid }, ref) => (
  <input
    ref={ref}
    aria-label={label}
    aria-invalid={invalid || undefined}
    value={value}
    disabled={disabled}
    inputMode={allowRecovery ? 'text' : 'numeric'}
    autoComplete="one-time-code"
    autoCapitalize={allowRecovery ? 'characters' : 'none'}
    autoCorrect="off"
    spellCheck={false}
    pattern={allowRecovery ? undefined : '[0-9]*'}
    maxLength={allowRecovery ? 9 : 7}
    placeholder={allowRecovery ? 'XXXX-XXXX' : '000 000'}
    onChange={(e) => {
      const raw = e.target.value;
      if (allowRecovery) { onChange(raw.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9)); return; }
      const digits = raw.replace(/\D/g, '').slice(0, 6);
      onChange(digits);
      if (digits.length === 6 && value.length !== 6) onComplete?.(digits);
    }}
    className={cn(
      'h-14 w-full rounded-md border border-solid bg-[var(--bg)] px-3 text-center font-mono text-[26px] tracking-[0.35em] text-foreground',
      'placeholder:text-[var(--dim)] placeholder:tracking-[0.2em] focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50',
      invalid ? 'border-[var(--down)]' : 'border-border',
    )}
  />
));
CodeInput.displayName = 'CodeInput';
