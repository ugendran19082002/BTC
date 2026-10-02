import { useRef, useState } from 'react';
import { Columns3, Check, ChevronUp, ChevronDown, GripVertical } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  CHAIN_COLUMNS, DEFAULT_COLUMNS, DEFAULT_ORDER, REQUIRED_COLUMNS, columnsInOrder, moveColumn, shownCount,
  type ColumnKey, type ColumnOrder, type ColumnState,
} from '@/components/chain/columns';

/**
 * Which columns the board shows, one at a time.
 *
 * It used to be two presets, "key" and "all", and neither was what anyone
 * wanted: "key" hid open interest, "all" put twenty-seven columns on a phone.
 * A reader who wants the odds, the bid and open interest and nothing else could
 * not ask for that.
 *
 * Each row says what the column is *for* rather than repeating its heading — a
 * list of fifteen abbreviations is not a list anyone can choose from. The bid
 * cannot be turned off: it is what a seller receives, and a board without it
 * cannot be acted on.
 *
 * ## Moving them
 *
 * The order here is the order on the board, calls read outward and puts the
 * mirror of it. Which column sits next to the strike is the one real layout
 * decision on this screen — it is the column the eye lands on — and it was
 * fixed in a source file.
 *
 * Three ways to move a row, all ending in the same pure `moveColumn`: drag it,
 * press the arrows beside it, or hold a row with the keyboard and use ↑/↓.
 * Drag alone would have been the obvious build and the wrong one: it does not
 * work from a keyboard, and on a touch screen a drag inside a scrolling list
 * fights the scroll.
 *
 * Both the arrangement and the on/off choices are remembered in `localStorage`,
 * not `sessionStorage`: a board somebody arranged is a preference, and having
 * to arrange it again in every new tab is the same as not saving it. Reset puts
 * both back.
 */
export function ColumnPicker({
  value,
  onChange,
  order = DEFAULT_ORDER,
  onOrderChange,
}: {
  value: ColumnState;
  onChange: (next: ColumnState) => void;
  /** The order the board draws them in. Left out, the file's own order. */
  order?: ColumnOrder;
  onOrderChange?: (next: ColumnKey[]) => void;
}) {
  const shown = shownCount(value);
  const cols = columnsInOrder(order);
  const toggle = (key: ColumnKey) => {
    if (REQUIRED_COLUMNS.includes(key)) return;
    onChange({ ...value, [key]: !value[key] });
  };

  /** The row being dragged, held in a ref because a drag is not a render. */
  const dragging = useRef<ColumnKey | null>(null);
  /** The row a keyboard has picked up, which is a render: it is shown held. */
  const [held, setHeld] = useState<ColumnKey | null>(null);

  const moveTo = (key: ColumnKey, to: number) => {
    if (!onOrderChange) return;
    onOrderChange(moveColumn(cols.map((c) => c.key), key, to));
  };
  const nudge = (key: ColumnKey, by: -1 | 1) => {
    const at = cols.findIndex((c) => c.key === key);
    if (at === -1) return;
    moveTo(key, at + by);
  };

  return (
    <Popover>
      <PopoverTrigger className="chain-chip" aria-label="which columns to show">
        <Columns3 size={13} aria-hidden /> Columns
        <span className="dim">{shown}/{CHAIN_COLUMNS.length}</span>
      </PopoverTrigger>
      <PopoverContent className="colpick">
        <div className="colpick-head">
          <span>Columns</span>
          <span className="colpick-actions">
            {/* Every column, or none: the two ends a person starts from before picking. */}
            <button type="button" className="colpick-reset" disabled={shown === CHAIN_COLUMNS.length}
              onClick={() => onChange(Object.fromEntries(CHAIN_COLUMNS.map((c) => [c.key, true])) as ColumnState)}>
              Select all
            </button>
            <button type="button" className="colpick-reset" disabled={shown === 0}
              onClick={() => onChange(Object.fromEntries(CHAIN_COLUMNS.map((c) => [c.key, false])) as ColumnState)}>
              Deselect all
            </button>
            <button
              type="button"
              className="colpick-reset"
              onClick={() => { onChange({ ...DEFAULT_COLUMNS }); onOrderChange?.([...DEFAULT_ORDER]); }}
            >
              Reset
            </button>
          </span>
        </div>

        {onOrderChange && (
          <p className="colpick-hint">
            Drag a row, or use the arrows, to change where the column sits on the board.
            The first one here sits furthest from the strike.
          </p>
        )}

        <ul className="colpick-list">
          {cols.map((c, i) => {
            const on = value[c.key];
            const fixed = REQUIRED_COLUMNS.includes(c.key);
            const movable = Boolean(onOrderChange);
            return (
              <li
                key={c.key}
                className={`colpick-item${held === c.key ? ' held' : ''}`}
                draggable={movable}
                onDragStart={(e) => { dragging.current = c.key; e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => { if (dragging.current && dragging.current !== c.key) e.preventDefault(); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragging.current;
                  dragging.current = null;
                  if (from && from !== c.key) moveTo(from, i);
                }}
                onDragEnd={() => { dragging.current = null; }}
              >
                {movable && (
                  <span
                    className="colpick-grip"
                    // The whole row drags; this is the handle that says so, and
                    // the keyboard's way in -- Space picks the row up, then the
                    // arrows move it, which is how a list is reordered without
                    // a mouse.
                    role="button"
                    tabIndex={0}
                    aria-label={`Move ${c.label}. ${held === c.key ? 'Held — use the arrow keys, then Space to drop.' : `Position ${i + 1} of ${cols.length}.`}`}
                    aria-pressed={held === c.key}
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        setHeld(held === c.key ? null : c.key);
                        return;
                      }
                      if (held !== c.key) return;
                      if (e.key === 'ArrowUp') { e.preventDefault(); nudge(c.key, -1); }
                      if (e.key === 'ArrowDown') { e.preventDefault(); nudge(c.key, 1); }
                      if (e.key === 'Escape') setHeld(null);
                    }}
                  >
                    <GripVertical size={12} aria-hidden />
                  </span>
                )}
                <button
                  type="button"
                  className={`colpick-row${on ? ' on' : ''}${fixed ? ' fixed' : ''}`}
                  onClick={() => toggle(c.key)}
                  aria-pressed={on}
                  disabled={fixed}
                  title={fixed ? 'The bid is what you receive — it always shows.' : c.why}
                >
                  <span className="colpick-box" aria-hidden>
                    {on && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="colpick-text">
                    <span className="colpick-label">
                      {c.label}
                      <span className="colpick-short">{c.short}</span>
                    </span>
                    <span className="colpick-why">{c.why}</span>
                  </span>
                </button>
                {movable && (
                  <span className="colpick-moves">
                    <button
                      type="button"
                      aria-label={`Move ${c.label} earlier`}
                      disabled={i === 0}
                      onClick={() => nudge(c.key, -1)}
                    >
                      <ChevronUp size={12} aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${c.label} later`}
                      disabled={i === cols.length - 1}
                      onClick={() => nudge(c.key, 1)}
                    >
                      <ChevronDown size={12} aria-hidden />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
