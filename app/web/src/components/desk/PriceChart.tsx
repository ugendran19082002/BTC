import { useMemo, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import type { Candle } from '@/types/desk';
import { strike as fmtStrike } from '@/lib/format';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type ChartTf = '5m' | '15m' | '1h' | '4h' | '1d';

export const CHART_TFS: readonly ChartTf[] = ['5m', '15m', '1h', '4h', '1d'];

const W = 780;
const H = 340;
const PAD = { top: 10, right: 74, bottom: 26, left: 8 };
/** The bottom fifth is volume. Price gets the rest. */
const VOL_SHARE = 0.2;
const GAP = 8;

const IST = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', ...opts });
const IST_TIME = IST({ hour: '2-digit', minute: '2-digit', hour12: false });
const IST_DAY = IST({ day: 'numeric', month: 'short' });
const IST_FULL = IST({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Recent BTC, with the two open-interest walls drawn against it.
 *
 * The walls are the reason this chart is here. `structure.ts` has always known
 * where the heaviest put and call strikes sit, and the number alone
 * ("resistance 80,000") says nothing about whether BTC is anywhere near it.
 *
 * ## Why the scale is price's, not the walls'
 *
 * The first version stretched the scale to reach both walls, so nothing was
 * ever clipped. On a real board that meant a 74,400–80,000 axis for a day that
 * traded 76,000–78,000, and every candle collapsed into a band a few pixels
 * tall — the chart was legible about the walls and useless about price, which
 * is backwards. Now the scale belongs to the bars, and a wall outside it is
 * pinned to the edge with an arrow and how far away it is. Nothing is hidden,
 * and the candles are readable.
 *
 * What it is not: a signal. Open interest is positioning, and every attempt to
 * trade it failed the cross-period screen — see TODO.md.
 */
export function PriceChart({
  bars,
  support,
  resistance,
  spot,
  expectedMove = null,
  tf,
  onTf,
  loading = false,
  error,
}: {
  bars: Candle[];
  /** Heaviest put strike, or null when the board has no open interest to read. */
  support: number | null;
  /** Heaviest call strike. */
  resistance: number | null;
  spot: number;
  /** ± this much by settlement, shaded behind the candles. */
  expectedMove?: number | null;
  tf: ChartTf;
  onTf: (tf: ChartTf) => void;
  loading?: boolean;
  error?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Three hundred pixels of chart on a phone is most of the screen, and some
  // days nobody wants it. Folded, the title still says where the walls are.
  const [open, setOpen] = usePersisted('open:price-chart', true);

  const view = useMemo(() => {
    if (!bars.length) return null;

    // The scale is the bars' own, plus the spot line which is always near them.
    let lo = Math.min(...bars.map((b) => b.low), spot);
    let hi = Math.max(...bars.map((b) => b.high), spot);
    const span = hi - lo || 1;
    lo -= span * 0.08;
    hi += span * 0.08;

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const volH = plotH * VOL_SHARE;
    const priceH = plotH - volH - GAP;

    const y = (p: number) => PAD.top + ((hi - p) / (hi - lo)) * priceH;
    const step = plotW / bars.length;
    const x = (i: number) => PAD.left + i * step + step / 2;
    const bodyW = Math.max(1, Math.min(11, step * 0.66));

    const maxVol = Math.max(...bars.map((b) => b.volume), 1);
    const volTop = PAD.top + priceH + GAP;
    const volY = (v: number) => volTop + volH - (v / maxVol) * volH;

    const ticks: number[] = [];
    const rough = (hi - lo) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const stepPrice = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((sp) => sp >= rough) ?? rough;
    for (let p = Math.ceil(lo / stepPrice) * stepPrice; p <= hi; p += stepPrice) ticks.push(p);

    const timeTicks = [0, Math.floor(bars.length / 3), Math.floor((bars.length * 2) / 3), bars.length - 1]
      .filter((i, n, a) => i >= 0 && a.indexOf(i) === n)
      .map((i) => ({ i, bar: bars[i]! }));

    return { lo, hi, y, x, step, bodyW, ticks, timeTicks, volY, volTop, volH, priceH };
  }, [bars, spot]);

  /**
   * Where a level is drawn: on the axis if the scale reaches it, pinned inside
   * the price area's edge if it does not.
   *
   * Well inside, not on the edge. At 7px the bottom pin, the volume baseline
   * and the lowest gridline label all landed within a few pixels of each other
   * and drew over one another.
   */
  const levelY = (value: number): number | null => {
    if (!view) return null;
    if (value >= view.lo && value <= view.hi) return view.y(value);
    return value > view.hi ? PAD.top + 11 : PAD.top + view.priceH - 11;
  };

  /** Every level's tag position, so a price label never draws under one. */
  const pinned = view
    ? [support, resistance, spot]
        .filter((v): v is number => v !== null)
        .map(levelY)
        .filter((v): v is number => v !== null)
    : [];

  /** A level inside the scale is a line; one outside is pinned to the edge. */
  const level = (value: number, colour: string, label: string) => {
    if (!view) return null;
    const inside = value >= view.lo && value <= view.hi;
    const yPos = levelY(value)!;
    const away = ((value - spot) / spot) * 100;
    const text = inside ? label : `${value > view.hi ? '▲' : '▼'} ${label}`;
    return (
      <g>
        <line
          x1={PAD.left} x2={W - PAD.right} y1={yPos} y2={yPos}
          stroke={colour} strokeWidth={inside ? 1.5 : 1} strokeDasharray={inside ? '6 4' : '2 4'}
          opacity={inside ? 1 : 0.65}
        />
        <rect x={W - PAD.right + 3} y={yPos - 8} width={PAD.right - 6} height="16" rx="3" fill={colour} />
        <text
          x={W - PAD.right + 3 + (PAD.right - 6) / 2} y={yPos + 4}
          textAnchor="middle" fontSize="10.5" fontWeight="600" fill="var(--bg)"
        >
          {text}
        </text>
        {!inside && (
          <text
            x={PAD.left + 4}
            y={value > view.hi ? yPos + 15 : yPos - 7}
            fontSize="10"
            fill={colour}
            opacity="0.85"
          >
            {label} · {Math.abs(away).toFixed(1)}% away, off the scale
          </text>
        )}
      </g>
    );
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const el = svgRef.current;
    if (!el || !view || !bars.length) return;
    const box = el.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round((vx - PAD.left - view.step / 2) / view.step);
    setHover(i >= 0 && i < bars.length ? i : null);
  };

  const shown = hover !== null ? bars[hover] : bars.at(-1);
  const shownUp = shown ? shown.close >= shown.open : true;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="price-chart">
      <div className="price-chart-head">
        <Collapsible.Trigger className="price-chart-title" aria-label="price chart">
          <ChevronDown className={`smr-chev${open ? '' : ' shut'}`} size={13} aria-hidden />
          BTC · {tf === '1d' ? 'daily' : tf}
          {support !== null && resistance !== null && (
            <span className="dim"> · walls {fmtStrike(support)}–{fmtStrike(resistance)}</span>
          )}
        </Collapsible.Trigger>
        <ToggleGroup
          type="single"
          value={tf}
          onValueChange={(v) => v && onTf(v as ChartTf)}
          aria-label="chart timeframe"
        >
          {CHART_TFS.map((t) => (
            <ToggleGroupItem key={t} value={t}>{t === '1d' ? '1D' : t}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <Collapsible.Content>
      {/* The bar under the pointer, or the last one — always saying which. */}
      {shown && !error && (
        <div className="price-chart-ohlc">
          <span className="dim">{hover === null ? 'last' : IST_FULL.format(shown.time * 1000)}</span>
          <span>O <b>{fmtStrike(Math.round(shown.open))}</b></span>
          <span>H <b>{fmtStrike(Math.round(shown.high))}</b></span>
          <span>L <b>{fmtStrike(Math.round(shown.low))}</b></span>
          <span>C <b className={shownUp ? 'up' : 'down'}>{fmtStrike(Math.round(shown.close))}</b></span>
        </div>
      )}

      {error ? (
        <div className="note" style={{ padding: '10px 12px', margin: 0 }}>
          The price feed did not answer, so the chart is empty. Everything below still reads
          from the chain.
        </div>
      ) : !view ? (
        <div className="price-chart-empty">{loading ? 'Loading bars…' : 'No bars for this range.'}</div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="price-chart-svg"
          role="img"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          aria-label={`BTC ${tf} candles, ${bars.length} bars, with open-interest walls at ${support ?? '—'} and ${resistance ?? '—'}`}
        >
          {view.ticks.map((p) => (
            <g key={p}>
              <line
                x1={PAD.left} x2={W - PAD.right} y1={view.y(p)} y2={view.y(p)}
                stroke="var(--line-soft)" strokeWidth="1"
              />
              <text
                x={W - PAD.right + 6}
                y={view.y(p) + 4}
                fontSize="10.5"
                fill="var(--dim)"
                /* The level tags own the right-hand gutter; a price label under
                   one is unreadable, so it gives way rather than overlapping. */
                opacity={pinned.some((q) => Math.abs(q - view.y(p)) < 11) ? 0 : 1}
              >
                {fmtStrike(Math.round(p))}
              </text>
            </g>
          ))}

          {/*
            What the options are pricing, behind what BTC has done. Drawn first
            so the candles sit on top of it: it is the backdrop the bars are
            read against, not a mark of its own.
          */}
          {expectedMove !== null && expectedMove > 0 && (
            <g>
              <rect
                x={PAD.left}
                y={Math.max(PAD.top, view.y(spot + expectedMove))}
                width={W - PAD.right - PAD.left}
                height={Math.max(
                  0,
                  Math.min(PAD.top + view.priceH, view.y(spot - expectedMove))
                    - Math.max(PAD.top, view.y(spot + expectedMove)),
                )}
                fill="var(--accent)"
                opacity="0.055"
              />
              <text x={PAD.left + 4} y={PAD.top + view.priceH - 4} fontSize="9.5" fill="var(--dim)">
                shaded: ±${Math.round(expectedMove).toLocaleString()} expected by expiry
              </text>
            </g>
          )}

          {/* volume, under its own baseline */}
          <line
            x1={PAD.left} x2={W - PAD.right} y1={view.volTop + view.volH} y2={view.volTop + view.volH}
            stroke="var(--line)" strokeWidth="1"
          />
          {bars.map((b, i) => (
            <rect
              key={`v${b.time}`}
              x={view.x(i) - view.bodyW / 2}
              y={view.volY(b.volume)}
              width={view.bodyW}
              height={Math.max(0.5, view.volTop + view.volH - view.volY(b.volume))}
              fill={b.close >= b.open ? 'var(--up)' : 'var(--down)'}
              opacity="0.32"
            />
          ))}

          {/* candles */}
          {bars.map((b, i) => {
            const colour = b.close >= b.open ? 'var(--up)' : 'var(--down)';
            const top = view.y(Math.max(b.open, b.close));
            const bottom = view.y(Math.min(b.open, b.close));
            return (
              <g key={b.time}>
                <line
                  x1={view.x(i)} x2={view.x(i)} y1={view.y(b.high)} y2={view.y(b.low)}
                  stroke={colour} strokeWidth="1"
                />
                <rect
                  x={view.x(i) - view.bodyW / 2}
                  y={top}
                  width={view.bodyW}
                  height={Math.max(1, bottom - top)}
                  fill={colour}
                  rx={view.bodyW > 5 ? 1 : 0}
                />
              </g>
            );
          })}

          {support !== null && level(support, 'var(--up)', fmtStrike(support))}
          {resistance !== null && level(resistance, 'var(--down)', fmtStrike(resistance))}
          {level(spot, 'var(--accent)', fmtStrike(Math.round(spot)))}

          {/* crosshair */}
          {hover !== null && bars[hover] && (
            <g pointerEvents="none">
              <line
                x1={view.x(hover)} x2={view.x(hover)} y1={PAD.top} y2={view.volTop + view.volH}
                stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3"
              />
              <line
                x1={PAD.left} x2={W - PAD.right}
                y1={view.y(bars[hover]!.close)} y2={view.y(bars[hover]!.close)}
                stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3"
              />
            </g>
          )}

          {view.timeTicks.map(({ i, bar }) => (
            <text
              key={bar.time}
              x={view.x(i)}
              y={H - 8}
              fontSize="10.5"
              fill="var(--dim)"
              textAnchor={i === 0 ? 'start' : i === bars.length - 1 ? 'end' : 'middle'}
            >
              {tf === '1d' ? IST_DAY.format(bar.time * 1000) : IST_TIME.format(bar.time * 1000)}
            </text>
          ))}
        </svg>
      )}

      <div className="price-chart-key">
        <span><i style={{ background: 'var(--up)' }} /> support · heaviest put strike</span>
        <span><i style={{ background: 'var(--down)' }} /> resistance · heaviest call strike</span>
        <span className="dim">where open interest sits, not where BTC will settle · times IST</span>
      </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
