import type { MtmReport } from '@/types/report';
import { inr, signedInr, usdToInr } from '@/lib/format';

/**
 * One day, minute by minute: what the day was worth at each reading, with
 * every fall from a high shaded underneath. The four numbers beside it are
 * the ones a person asks about a day -- where it is, how low it went and when,
 * how high, and the worst fall on the way.
 */
const W = 640;
const H = 240;
const PAD = { top: 12, right: 12, bottom: 24, left: 58 };

const IST_TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
export const clockIst = (ms: number) => IST_TIME.format(ms);

export function MtmChart({ report }: { report: MtmReport }) {
  const s = report.samples;
  if (s.length === 0) {
    return <div className="pnl-empty">No readings for {report.day} — the desk writes one a minute while something is on.</div>;
  }
  const values = [0, ...s.map((p) => p.netUsd)];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const t0 = s[0]!.at;
  const t1 = s[s.length - 1]!.at;
  const x = (at: number) => PAD.left + (t1 === t0 ? plotW / 2 : ((at - t0) / (t1 - t0)) * plotW);
  const y = (v: number) => PAD.top + ((hi - v) / span) * plotH;

  const line = s.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(p.netUsd).toFixed(1)}`).join(' ');

  /*
   * The drawdown, shaded: at each reading, the gap between the running high
   * and the reading. A closed shape from the peak-line down to the value-line,
   * so a day that only climbed shades nothing and a fall shows as exactly the
   * area it gave back.
   */
  let peak = s[0]!.netUsd;
  const peaks = s.map((p) => (peak = Math.max(peak, p.netUsd)));
  const shade = [
    ...s.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(peaks[i]!).toFixed(1)}`),
    ...[...s].reverse().map((p) => `L${x(p.at).toFixed(1)},${y(p.netUsd).toFixed(1)}`),
    'Z',
  ].join(' ');

  const st = report.stats;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + t * span);
  const timeTicks = [t0, t0 + (t1 - t0) / 3, t0 + (2 * (t1 - t0)) / 3, t1];
  const tone = (st.nowUsd ?? 0) > 0 ? 'var(--up)' : (st.nowUsd ?? 0) < 0 ? 'var(--down)' : 'var(--muted)';

  return (
    <div className="mtm">
      <div className="mtm-figures">
        <Fig label={`${report.day === todayKey() ? "Today's" : 'Day'} P&L`} value={signedInr(usdToInr(st.nowUsd))} big
          tone={st.nowUsd == null ? undefined : st.nowUsd > 0 ? 'up' : st.nowUsd < 0 ? 'down' : undefined} />
        <Fig label="Low" value={signedInr(usdToInr(st.min?.netUsd))} sub={st.min ? `at ${clockIst(st.min.at)}` : undefined} tone="down" />
        <Fig label="High" value={signedInr(usdToInr(st.max?.netUsd))} sub={st.max ? `at ${clockIst(st.max.at)}` : undefined} tone="up" />
        <Fig label="Worst fall" value={st.maxDrawdown ? `−${inr(usdToInr(st.maxDrawdown.usd))}` : '—'}
          sub={st.maxDrawdown && st.maxDrawdown.usd > 0 ? `bottomed ${clockIst(st.maxDrawdown.at)}` : undefined} tone="down" />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="pnl-svg" role="img"
        aria-label={`${report.day}, ${s.length} readings, now ${signedInr(usdToInr(st.nowUsd))}`}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--line-soft)" strokeWidth="1" />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--dim)">{inr(usdToInr(v))}</text>
          </g>
        ))}
        <path d={shade} fill="var(--down)" opacity="0.16" className="mtm-drawdown" />
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 4" />
        <path d={line} fill="none" stroke={tone} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="mtm-line" />
        {timeTicks.map((t, i) => (
          <text key={i} x={x(t)} y={H - 7} fontSize="10" fill="var(--dim)"
            textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}>
            {clockIst(t)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function Fig({ label, value, sub, tone, big }: {
  label: string; value: string; sub?: string; tone?: 'up' | 'down'; big?: boolean;
}) {
  return (
    <div className="mtm-fig">
      <span className="mtm-fig-label">{label}</span>
      <b className={`mtm-fig-value${big ? ' big' : ''}${tone ? ` ${tone}` : ''}`}>{value}</b>
      {sub && <small className="mtm-fig-sub">{sub}</small>}
    </div>
  );
}

const todayKey = () => {
  const d = new Date(Date.now() + 5.5 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
