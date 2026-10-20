import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTheme, type ThemeMode } from '@/lib/theme';

/**
 * Light, dark, or as the device is (owner, 20 Oct 2026): the same three on the desk's account menu and the phone's
 * Settings. Kept in this browser; another device keeps its own.
 */
const MODES: { key: ThemeMode; label: string; icon: typeof Sun }[] = [
  { key: 'light', label: 'Light', icon: Sun },
  { key: 'dark', label: 'Dark', icon: Moon },
  { key: 'system', label: 'Device', icon: Monitor },
];

export function ThemeSwitch({ className }: { className?: string }) {
  const { mode, theme, setMode } = useTheme();
  return (
    <div className={cn('grid min-w-0 gap-1.5', className)}>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {MODES.map(({ key, label, icon: Icon }) => (
          <button key={key} type="button" role="radio" aria-checked={mode === key} onClick={() => setMode(key)}
            className={cn('flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-md border-0 px-2 font-[inherit] text-[13.5px] font-semibold',
              mode === key ? 'bg-[var(--chosen)] text-[var(--chosen-ink)]' : 'bg-transparent text-muted-foreground hover:text-foreground')}>
            <Icon aria-hidden className="h-4 w-4 shrink-0" /> {label}
          </button>
        ))}
      </div>
      <p className="m-0 text-[12px] text-muted-foreground">
        {mode === 'system' ? `As this device is set: ${theme} now, and it follows the device when that changes.` : `${theme === 'light' ? 'Light' : 'Dark'} on this browser.`}
        {' '}Kept on this device only.
      </p>
    </div>
  );
}

/** One tap between light and dark, for the desk's top bar. */
export function ThemeToggle() {
  const { theme, setMode } = useTheme();
  const next = theme === 'light' ? 'dark' : 'light';
  const Icon = theme === 'light' ? Moon : Sun;
  return (
    <button type="button" onClick={() => setMode(next)} aria-label={`Switch to the ${next} theme`} title={`Switch to the ${next} theme`}
      className="m-0 flex h-9 w-9 flex-none appearance-none items-center justify-center rounded-full border border-solid border-border bg-muted p-0 text-foreground hover:border-[var(--accent)]">
      <Icon aria-hidden className="h-4 w-4" />
    </button>
  );
}
