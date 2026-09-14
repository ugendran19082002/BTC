import type { DayRow } from '@/types/report';
import { byDay, heat, monthsOf, netOf } from '@/lib/report';
import { signedInr, usdToInr } from '@/lib/format';

/**
 * Every day in the range as a square: green made money, red lost it, the
 * shade says how much against the biggest day. Read as a picture first -- a
 * run of red across a row is the thing the calendar exists to show -- and as
 * numbers on hover or tap.
 *
 * One month per column on a wide screen; on a phone the months scroll
 * sideways inside the card, seven squares wide each, because seven squares
 * is what a month is and squeezing them narrower turns the picture to noise.
 */
const DOW = ['S', 'M', 'T', 'W', 'Th', 'F', 'S'];

export function PnlCalendar({ rows, from, to, includeCharges, selected, onSelect }: {
  rows: DayRow[];
  from: string;
  to: string;
  includeCharges: boolean;
  selected: string | null;
  onSelect: (day: string) => void;
}) {
  const map = byDay(rows);
  const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(netOf(r, includeCharges))), 0);
  const months = monthsOf(from, to);

  return (
    <div className="pnl-cal" role="grid" aria-label="daily profit and loss">
      {months.map((m) => (
        <div key={m.key} className="pnl-month">
          <div className="pnl-month-label">{m.label}</div>
          <div className="pnl-dow" aria-hidden>
            {DOW.map((d, i) => <span key={i}>{d}</span>)}
          </div>
          {m.weeks.map((week, wi) => (
            <div key={wi} className="pnl-week" role="row">
              {week.map((day, di) => {
                if (day === null) return <span key={di} className="pnl-day empty" aria-hidden />;
                const row = map.get(day);
                const net = row ? netOf(row, includeCharges) : null;
                const tone = net === null ? 'none' : net > 0 ? 'up' : net < 0 ? 'down' : 'flat';
                const level = net === null ? 0 : heat(net, maxAbs);
                const label = row
                  ? `${day}: ${signedInr(usdToInr(net))}, ${row.trades} trade${row.trades === 1 ? '' : 's'}`
                  : `${day}: no trades`;
                return (
                  <button
                    key={day}
                    type="button"
                    role="gridcell"
                    className={`pnl-day ${tone} l${level}${selected === day ? ' selected' : ''}`}
                    title={label}
                    aria-label={label}
                    aria-selected={selected === day}
                    onClick={() => onSelect(day)}
                  >
                    <span className="pnl-day-n">{Number(day.slice(8))}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
