import { cn } from '@/lib/utils';
import type { MethodRead } from '@/types/entry';
import { GROUP_NAME, NumberBadge, SignalChip } from './parts';

/**
 * The twelve methods by number: 1 is Breakout, 2 Breakout + retest, and so on
 * -- the one place their names are written, so the two panels below can show
 * the number alone. Each row also carries the method's signal on both sides,
 * which is the comparison at a glance. Choosing a row chooses that method in
 * both panels.
 */
export function MethodLegend({ single, mtf, chosenN, onChoose }: {
  single: readonly MethodRead[];
  mtf: readonly MethodRead[];
  /** The method chosen in the panels, when both sides are on the same one. */
  chosenN: number | null;
  onChoose: (n: number) => void;
}) {
  const rows = (mtf.length ? mtf : single).map((m) => ({
    m,
    without: single.find((x) => x.n === m.n) ?? null,
    with: mtf.find((x) => x.n === m.n) ?? null,
  }));
  if (!rows.length) return null;
  return (
    <section aria-label="entry methods" className="mb-3 rounded-xl border border-border p-2.5">
      <h3 className="m-0 mb-1 text-[13px] font-bold">Entry methods <span className="font-normal text-muted-foreground">· the numbers used on both sides below</span></h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]" aria-label="entry methods by number">
          <thead className="text-left text-[11px] text-muted-foreground">
            <tr>
              <th className="py-1 pr-2">#</th>
              <th className="pr-2">Method</th>
              <th className="hidden pr-2 md:table-cell">Group</th>
              <th className="hidden pr-2 sm:table-cell">Looks for</th>
              <th className="px-1 text-center">Without<span className="hidden sm:inline"> TF</span></th>
              <th className="px-1 text-center">With<span className="hidden sm:inline"> TF</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, without, with: withTf }) => (
              <tr key={m.n} className={cn('border-t border-border', chosenN === m.n && 'bg-muted')}>
                <td className="py-1 pr-2"><NumberBadge read={m} /></td>
                <td className="pr-2">
                  <button type="button" onClick={() => onChoose(m.n)} className="min-h-[28px] text-left font-medium hover:underline">{m.name}</button>
                  {/* On a phone the "looks for" column folds in under the name. */}
                  <span className="block text-[11px] leading-snug text-muted-foreground sm:hidden">{m.summary}</span>
                </td>
                <td className="hidden pr-2 text-muted-foreground md:table-cell">{GROUP_NAME[m.group]}</td>
                <td className="hidden pr-2 text-muted-foreground sm:table-cell">{m.summary}</td>
                <td className="px-1 text-center">{without ? <SignalChip read={without} /> : '–'}</td>
                <td className="px-1 text-center">{withTf ? <SignalChip read={withTf} /> : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
