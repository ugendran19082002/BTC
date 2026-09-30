import { cn } from '@/lib/utils';
import type { EntryMode, MethodRead } from '@/types/entry';
import { gateTick } from './parts';

const GATE_TICK_CLASS: Record<ReturnType<typeof gateTick>, string> = {
  '✓': 'text-[var(--up)]', '✗': 'text-[var(--down)]', '–': 'text-muted-foreground',
};

/**
 * The hard gates as a checklist, beside the Entry methods table: each gate's
 * rule, what was read, and the verdict, for the method chosen there -- without
 * the timeframe chain or with it. Any ✗ is NO TRADE, however good the setup;
 * – is not read (no option board, no spread) or not part of that mode, and
 * refuses nothing; "off" is a gate switched off, still read, refusing nothing.
 */
export function GateChecklist({ selected, mode, onMode }: {
  /** Each way's chosen read. */
  selected: Record<EntryMode, MethodRead | null>;
  mode: EntryMode;
  onMode: (m: EntryMode) => void;
}) {
  const read = selected[mode];
  const gates = read?.dir ? read.gates : [];
  return (
    <section aria-label="hard gates" className="h-full rounded-xl border border-border p-2.5 text-[12px]">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-[13px] font-bold">Hard gates</h3>
        <div role="group" aria-label="hard gates for" className="inline-flex overflow-hidden rounded border border-border text-[11px]">
          {(['single', 'mtf'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => onMode(m)}
                    className={cn('px-2 py-0.5', mode === m ? 'bg-[#2563eb] text-white' : 'text-muted-foreground')}>
              {m === 'single' ? 'Without TF' : 'With TF'}
            </button>
          ))}
        </div>
      </div>
      <p className="m-0 mb-1.5 text-[11px] text-muted-foreground">
        {read ? <>#{read.n} {read.name} · </> : null}any ✗ is NO TRADE · off gates refuse nothing
      </p>
      {gates.length ? (
        <table className="w-full border-collapse">
          <tbody>
            {gates.map((g) => (
              <tr key={g.key} className={cn('border-t border-border first:border-t-0', !g.enabled && 'opacity-60')} title={g.why ?? undefined}>
                <td className={cn('w-4 py-0.5 align-top font-bold', GATE_TICK_CLASS[gateTick(g)])}
                    aria-label={!g.enabled ? (g.ok === false ? 'off, would refuse' : 'off') : g.ok === true ? 'passed' : g.ok === false ? 'refused' : 'not read'}>{gateTick(g)}</td>
                <td className="pr-2">
                  <span className="font-medium">{g.label}</span>
                  {!g.enabled ? <span className="ml-1 rounded bg-muted px-1 text-[10px] font-semibold uppercase text-[var(--warn)]">off</span> : null}
                  <span className="block text-[10.5px] leading-snug text-muted-foreground">{g.rule}</span>
                </td>
                <td className={cn('whitespace-nowrap text-right align-top tabular-nums', g.ok === false && g.enabled ? 'text-[var(--down)]' : 'text-muted-foreground')}>
                  {g.value ?? 'not read'}{!g.enabled && g.ok === false ? <span className="block text-[10px]">would refuse</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="m-0 text-muted-foreground">Read once a setup forms -- choose a method with a signal in the table.</p>
      )}
    </section>
  );
}
