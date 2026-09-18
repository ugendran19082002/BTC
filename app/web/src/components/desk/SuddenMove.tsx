import * as Collapsible from '@radix-ui/react-collapsible';
import {
  ArrowDownRight, ArrowUpRight, ChevronDown, Clock, Info, MoveHorizontal, Zap,
} from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import type {
  MarketRead, OptionStructure, Outlook, OutlookRow, SnapshotMeta, SuddenMove as Shock,
} from '@/types/desk';
import { strike as fmtStrike } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Whether something is happening right now, for the window chosen.
 *
 * Laid out after the design asked for on 17 September: the answer in the first
 * row -- the sudden-move risk, and how often BTC actually moved from moments like
 * this -- then why (pricing against history, what the tape is doing, the chart's
 * reading and its parts), then where price sits against the levels and the
 * board's own numbers.
 *
 * ## What is kept honest inside that layout
 *
 * * **Probability outlook** is *measured*: how often BTC moved more than the
 *   threshold over the next window, counted from 105,120 windows. Not a forecast,
 *   and the tooltip says so. The prices under it are spot ± that threshold, the
 *   same prices the range line below is drawn to.
 * * **Trend score** is the chart's recent reading, marked "(past)". The desk
 *   measured direction as a coin toss; the score says where candles have been.
 * * **Volume and open interest** carry the split between calls and puts, not a
 *   percentage change: the desk keeps no history to measure a change against.
 * * **Nothing on the trading side reads any of this**, and the footer says so.
 */

const BAND = {
  normal: { label: 'Normal', note: 'Nothing unusual on the tape' },
  watch: { label: 'Watch', note: 'Something is stirring' },
  high: { label: 'High risk', note: 'Abnormal move possible in the next few hours' },
  sudden: { label: 'Sudden move', note: 'A move is under way' },
} as const;

type Tone = 'plain' | 'warn' | 'bad' | 'up' | 'down';

const WINDOW_WORDS: Record<number, string> = { 5: '5 minutes', 15: '15 minutes', 60: '1 hour', 240: '4 hours' };
const WINDOW_LABEL: Record<number, string> = { 5: '5m', 15: '15m', 60: '1h', 240: '4h' };
const CONTRACT_BTC = 0.001;

/** "5 minutes", "1 hour", "4 hours" — never "1 hours". */
export const horizonWords = (minutes: number): string => {
  if (minutes < 60) return `${minutes} minutes`;
  const h = Math.round(minutes / 60);
  return h === 1 ? '1 hour' : `${h} hours`;
};

const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
});

const pctOf = (v: number) => `${Math.round(v * 100)}%`;
const usd = (v: number) => `$${Math.round(v).toLocaleString('en-IN')}`;
const signed = (v: number, places = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(places)}`;

/** "3h 12m" left on the contract, or "settled". */
export function expiresIn(hours: number): string {
  if (!(hours > 0)) return 'settled';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, '0')}m`;
}

/** The chart's reading in words, always marked as the past. */
export function trendWords(score: number | null): { badge: string; words: string; tone: Tone } {
  if (score === null) return { badge: 'NO CHART', words: 'No candles at this timeframe', tone: 'plain' };
  const a = Math.abs(score);
  const side = score >= 0 ? 'bullish' : 'bearish';
  const tone: Tone = score >= 0.3 ? 'up' : score <= -0.3 ? 'down' : 'plain';
  const badge = score >= 0.3 ? 'BULLISH' : score <= -0.3 ? 'BEARISH' : 'NEUTRAL';
  const words = a < 0.05 ? 'Flat (past)'
    : a < 0.3 ? `Slightly ${side} (past)`
      : a < 0.6 ? `${side[0]!.toUpperCase()}${side.slice(1)} (past)`
        : `Strongly ${side} (past)`;
  return { badge, words, tone };
}

function Hint({ text }: { text: string }) {
  return (
    <span className="smx-hint" title={text}>
      <Info size={11} aria-hidden />
    </span>
  );
}

/** The risk out of a hundred, as a ring, with its band inside. */
function Gauge({ score, band, tone }: { score: number; band: string; tone: Tone }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * c;
  return (
    <svg viewBox="0 0 100 100" className={`smx-ring smx-${tone}`} role="img" aria-label={`${score} out of 100`}>
      <circle cx="50" cy="50" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      <circle
        cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${filled} ${c - filled}`} transform="rotate(-90 50 50)"
      />
      <text x="50" y="50" textAnchor="middle" fontSize="26" fontWeight="700" fill="currentColor">{score}</text>
      <text x="50" y="66" textAnchor="middle" fontSize="9" fontWeight="600" letterSpacing="0.5" fill="currentColor">
        {band.toUpperCase()}
      </text>
    </svg>
  );
}

const part = (shock: Shock, name: string) => shock.parts.find((p) => p.name === name) ?? null;

export function SuddenMove({
  shocks, window, onWindow, snap, structure, market, outlook,
}: {
  /** One reading per window; the server computes all four. */
  shocks: Shock[];
  window: number;
  onWindow: (minutes: number) => void;
  snap: SnapshotMeta;
  structure: OptionStructure;
  market: MarketRead | null;
  /** The horizon cards' own figures, for pricing against history and the chart's reading. */
  outlook?: Outlook | null;
}) {
  // Foldable, but never silent: folded, the header still carries the score and the band.
  const [open, setOpen] = usePersisted('open:sudden-move', true);

  const shock = shocks.find((s) => s.window === window) ?? shocks[0];
  if (!shock || shock.score === null) return null;

  const band = BAND[shock.band];
  const riskTone: Tone = shock.band === 'sudden' || shock.band === 'high' ? 'bad' : shock.band === 'watch' ? 'warn' : 'up';
  const label = WINDOW_LABEL[shock.window] ?? `${shock.window}m`;
  const row: OutlookRow | null = outlook?.rows.find((r) => r.label === label) ?? null;

  const move = part(shock, 'Move against expected');
  const volume = part(shock, 'Volume spike');
  const iv = part(shock, 'Volatility repricing');

  // Unusual readings, and yet a 1% move has been rare after readings like them: both true, and said.
  const calmAnyway = shock.band !== 'normal' && shock.odds !== null && shock.odds.inside >= 0.9;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={`smx smx-band-${shock.band}`} aria-label="sudden move analytics">
      {/* ── header ─────────────────────────────────────────────────────────── */}
      <header className="smx-head">
        <div className="smx-head-left">
          <label className="smx-window">
            <Clock size={18} aria-hidden />
            <span className="sr-only">reading window</span>
            <select
              aria-label="reading window"
              value={shock.window}
              onChange={(e) => onWindow(Number(e.target.value))}
            >
              {shocks.map((s) => (
                <option key={s.window} value={s.window}>{(WINDOW_WORDS[s.window] ?? `${s.window} minutes`).toUpperCase()}</option>
              ))}
            </select>
            <ChevronDown size={16} aria-hidden className="smx-window-chev" />
          </label>
          <span className="smx-divider" aria-hidden />
          <span className="smx-expires">Expires in {expiresIn(snap.hoursToExpiry)}</span>
          <span className={cn('smx-badge', `smx-${riskTone}`)}>{band.label}</span>
          {!open && (
            <span className={cn('smx-folded', `smx-${riskTone}`)}>
              <b>{shock.score}</b>/100
            </span>
          )}
        </div>
        <div className="smx-head-right">
          <span className="smx-updated">
            <small>Last updated</small>
            <b>{IST.format(snap.ts * 1000)} IST</b>
          </span>
          <span className={cn('smx-live', !snap.live && 'off')}>
            <i aria-hidden />{snap.live ? 'Live' : 'Snapshot'}
          </span>
          <Collapsible.Trigger className="smx-fold" aria-label={open ? 'fold sudden move analytics' : 'open sudden move analytics'}>
            <Zap size={14} aria-hidden />
            <ChevronDown size={15} aria-hidden className={cn('smx-fold-chev', !open && 'shut')} />
          </Collapsible.Trigger>
        </div>
      </header>

      <Collapsible.Content>
        {/* ── row 1: the answer ──────────────────────────────────────────── */}
        <div className="smx-row1">
          <section className={cn('smx-card smx-hero', `smx-hero-${riskTone}`)} aria-label="sudden-move risk">
            <Gauge score={shock.score} band={band.label} tone={riskTone} />
            <div className="smx-hero-body">
              <h3>
                Sudden-move risk
                <Hint text="Price, volume, volatility and the option board, against their own recent past. A reading of now, not a forecast." />
              </h3>
              <p className="smx-hero-note">{band.note}</p>
              <p className="smx-hero-line">
                Price moved <b>{move?.detail?.headline ?? '—'}</b> what it was priced for
              </p>
              <p className="smx-hero-line">
                Volume is <b>{volume?.detail?.headline ?? '—'}</b> its usual
              </p>
              {calmAnyway && shock.odds && (
                <p className="smr-context smx-context">
                  Busier than usual — but over the next {horizonWords(shock.odds.overMinutes)} a {shock.odds.thresholdPct}% move has
                  been rare: <b>{Math.round(shock.odds.inside * 100)} in 100</b> stayed inside.
                </p>
              )}
              {shock.reasons.length > 0 && (
                <ul className="smr-reasons smx-reasons">
                  {shock.reasons.map((r) => <li key={r}>{r}</li>)}
                </ul>
              )}
            </div>
          </section>

          {shock.odds ? (
            <section className="smx-card smx-prob" aria-label="probability outlook">
              <h3 className="smx-title">
                Probability outlook
                <Hint text="How often BTC actually moved more than this over the next window, counted off 105,120 measured windows. A frequency that happened, not a forecast." />
              </h3>
              <div
                className="smx-probbar"
                role="img"
                aria-label={`down ${pctOf(shock.odds.down)}, sideways ${pctOf(shock.odds.inside)}, up ${pctOf(shock.odds.up)}`}
              >
                <i className="down" style={{ flexGrow: shock.odds.down }} />
                <i className="flat" style={{ flexGrow: shock.odds.inside }} />
                <i className="up" style={{ flexGrow: shock.odds.up }} />
              </div>
              <div className="smx-probcols">
                <div className="down">
                  <b>{pctOf(shock.odds.down)}</b>
                  <span>Down</span>
                  <small>&lt; {fmtStrike(Math.round(snap.spot * (1 - shock.odds.thresholdPct / 100)))}</small>
                </div>
                <div className="flat">
                  <b>{pctOf(shock.odds.inside)}</b>
                  <span>Sideways ±{shock.odds.thresholdPct}%</span>
                  <small>
                    {fmtStrike(Math.round(snap.spot * (1 - shock.odds.thresholdPct / 100)))} – {fmtStrike(Math.round(snap.spot * (1 + shock.odds.thresholdPct / 100)))}
                  </small>
                </div>
                <div className="up">
                  <b>{pctOf(shock.odds.up)}</b>
                  <span>Up</span>
                  <small>&gt; {fmtStrike(Math.round(snap.spot * (1 + shock.odds.thresholdPct / 100)))}</small>
                </div>
              </div>
              <p className="smx-foot">
                {/*
                  The ±1% line, said out loud. The outlook cards further down
                  also say Down / Side / Up, over a band a tenth the width, and
                  read side by side the two looked like a contradiction
                  (98% here, 33% there) -- the same words over different lines.
                */}
                a ±{shock.odds.thresholdPct}% line, not the outlook cards’ narrower band · over the next {horizonWords(shock.odds.overMinutes)}, measured · half moved less than{' '}
                <b>±{shock.odds.typicalPct.toFixed(2)}%</b>, nineteen in twenty less than <b>±{shock.odds.outerPct.toFixed(2)}%</b>
              </p>
            </section>
          ) : (
            <section className="smx-card smx-prob smx-empty">No measured odds for this window.</section>
          )}
        </div>

        {/* ── row 2: why ─────────────────────────────────────────────────── */}
        <div className="smx-row2">
          <PricingCard row={row} spot={snap.spot} label={label} />

          <section className="smx-card" aria-label="right now">
            <h3 className="smx-title">
              Right now
              <Hint text="The last window's range against what it was priced to move, and the newest bar's volume against the median of the twenty before it." />
            </h3>
            <Reading
              name="Move vs expected"
              headline={move?.detail?.headline ?? '—'}
              now={move?.detail?.now ?? 'No 5-minute range to read'}
              before={move?.detail?.before ?? 'No volatility to price it from'}
              chip={move?.detail ? (move.value >= 0.5 ? 'Above expected' : 'Within expected') : null}
              warn={Boolean(move?.detail && move.value >= 0.5)}
            />
            <Reading
              name="Volume"
              headline={volume?.detail?.headline ?? '—'}
              now={volume?.detail?.now ?? 'No bars to read'}
              before={volume?.detail?.before ?? 'No median to compare against'}
              chip={volume?.detail ? (volume.value >= 0.5 ? 'High activity' : 'Ordinary') : null}
              warn={Boolean(volume?.detail && volume.value >= 0.5)}
            />
          </section>

          <TrendCard row={row} />

          <FactorsCard row={row} shock={shock} />
        </div>

        {/* ── row 3: where price sits ────────────────────────────────────── */}
        <div className="smx-row3">
          <RangeCard snap={snap} row={row} shock={shock} label={label} />

          <section className="smx-card smx-stats" aria-label="board numbers">
            <Stat
              label="IV (ATM)"
              value={snap.atmIv === null ? '—' : `${(snap.atmIv * 100).toFixed(1)}%`}
              foot={iv?.detail ? `${iv.detail.headline} · ${iv.detail.before}` : 'No reading yet'}
              sub={iv?.detail ? undefined : 'The desk records one every five minutes'}
              hint="At-the-money implied volatility, per year. How much movement the option market is charging for."
            />
            {/*
              The board, both sides, every time: the total was there and the
              split was one percentage. Calls and puts each in their own words,
              and the put/call ratio named as what it is -- 0.69 read as "puts
              per call" on 18 September and had to be asked about.
            */}
            <Stat
              label="Options volume"
              value={`${Math.round(structure.ceVolume + structure.peVolume).toLocaleString('en-IN')}`}
              foot={structure.ceVolume + structure.peVolume > 0
                ? `CE ${Math.round(structure.ceVolume).toLocaleString('en-IN')} · PE ${Math.round(structure.peVolume).toLocaleString('en-IN')} contracts`
                : 'contracts'}
              sub={structure.pcrVolume === null
                ? undefined
                : `PCR (volume) ${structure.pcrVolume.toFixed(2)} · ${sideWords(structure.pcrVolume, 'traded')}`}
              hint="Contracts traded on this expiry, as Delta reports it. PCR = puts ÷ calls: under 1 is more calls, over 1 more puts."
            />
            <Stat
              label="Open interest"
              value={`${((structure.ceOi + structure.peOi) * CONTRACT_BTC).toLocaleString('en-IN', { maximumFractionDigits: 1 })} BTC`}
              foot={`CE ${(structure.ceOi * CONTRACT_BTC).toLocaleString('en-IN', { maximumFractionDigits: 1 })} · PE ${(structure.peOi * CONTRACT_BTC).toLocaleString('en-IN', { maximumFractionDigits: 1 })} BTC`}
              sub={structure.pcrOi === null
                ? 'no puts or calls open'
                : `PCR (OI) ${structure.pcrOi.toFixed(2)} · ${sideWords(structure.pcrOi, 'open')}`}
              hint="Contracts open on this expiry, at 0.001 BTC each. PCR = put OI ÷ call OI. Positioning, not a forecast."
            />
            {/*
              The walls within reach, the same pair the summary and the chart
              draw. This card printed 71,000 – 89,000 on 18 September: the
              heaviest open interest on the whole board, and neither one a level
              anybody could trade against ten hours from settlement.
            */}
            <Stat
              label="OI walls"
              value={structure.peOiWallNear && structure.ceOiWallNear
                ? `${fmtStrike(structure.peOiWallNear.strike)} – ${fmtStrike(structure.ceOiWallNear.strike)}`
                : structure.peOiWallNear || structure.ceOiWallNear
                  ? `${structure.peOiWallNear ? fmtStrike(structure.peOiWallNear.strike) : 'none'} – ${structure.ceOiWallNear ? fmtStrike(structure.ceOiWallNear.strike) : 'none'}`
                  : 'none near'}
              foot={structure.peOiWallNear && structure.ceOiWallNear
                ? `PE ${oiShort(structure.peOiWallNear.value)} · CE ${oiShort(structure.ceOiWallNear.value)} open`
                : 'support – resistance'}
              sub={structure.peOiWall && structure.ceOiWall
                ? `whole board ${fmtStrike(structure.peOiWall.strike)} – ${fmtStrike(structure.ceOiWall.strike)}`
                : undefined}
              hint={`The heaviest put and call open interest within ${structure.wallWithinEm ?? 2} expected moves of spot. Where positions sit, not where BTC stops.`}
            />
          </section>
        </div>

        <p className="smx-note">
          For information. Nothing on the trading side reads any of this — none of these weights
          has been measured across 2024, 2025 and 2026 the way the premium floor and the RSI gate
          were.
        </p>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function Reading({ name, headline, now, before, chip, warn }: {
  name: string; headline: string; now: string; before: string; chip: string | null; warn: boolean;
}) {
  return (
    <div className={cn('smx-reading', warn && 'warn')}>
      <div className="smx-reading-head">
        <span>{name}</span>
        <b>{headline}</b>
        {chip && <span className="smx-chip">{chip}</span>}
      </div>
      <div className="smx-reading-rows"><span>{now}</span><span>{before}</span></div>
    </div>
  );
}

/** Implied against measured, for this window: what the market charges against what BTC usually does. */
function PricingCard({ row, spot, label }: { row: OutlookRow | null; spot: number; label: string }) {
  const usual = row?.measured68Pct == null ? null : (spot * row.measured68Pct) / 100;
  const word = row?.priced === 'rich' ? 'RICH' : row?.priced === 'cheap' ? 'CHEAP' : 'FAIR';
  const sentence = row?.priced === 'rich'
    ? 'Options are priced above what BTC usually moves — a seller is paid more than the usual risk.'
    : row?.priced === 'cheap'
      ? 'Options are priced below what BTC usually moves — a seller is paid less than the usual risk.'
      : 'Options are priced fairly for this timeframe.';
  return (
    <section className="smx-card" aria-label="pricing vs history">
      <h3 className="smx-title">
        Pricing vs history
        <Hint text="The move options imply (spot × IV × √t) against the move BTC made two times in three over this window, across 105,119 measured windows." />
      </h3>
      {row?.richness == null ? (
        <p className="smx-empty">Nothing to compare for {label}</p>
      ) : (
        <>
          <div className="smx-bigline">
            <b>{row.richness.toFixed(2)}×</b>
            <span className={cn('smx-pill', row.priced)}>{word}</span>
          </div>
          <p className="smx-line">Options imply <b>±{usd(row.impliedUsd ?? 0)}</b></p>
          <p className="smx-line">BTC usually moves <b>±{usd(usual ?? 0)}</b> ({row.measured68Pct!.toFixed(2)}%)</p>
          <p className="smx-foot">{sentence}</p>
        </>
      )}
    </section>
  );
}

function TrendCard({ row }: { row: OutlookRow | null }) {
  const score = row?.score ?? null;
  const t = trendWords(score);
  const Arrow = score === null || t.tone === 'plain' ? MoveHorizontal : score > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <section className="smx-card" aria-label="trend score">
      <h3 className="smx-title">
        Trend score
        <Hint text={`Where this timeframe's candles have been heading, −1 to +1${row?.why ? `: ${row.why}` : ''}. The recent past, not a forecast — the desk measured direction as a coin toss.`} />
      </h3>
      <div className="smx-bigline">
        <span className={cn('smx-arrow', `smx-${t.tone}`)}><Arrow size={18} aria-hidden /></span>
        <b className={`smx-${t.tone}`}>{score === null ? '—' : signed(score)}</b>
        <span className={cn('smx-pill', t.tone === 'up' ? 'rich' : t.tone === 'down' ? 'cheap' : 'neutral')}>{t.badge}</span>
      </div>
      <p className="smx-line">{t.words}</p>
    </section>
  );
}

function FactorsCard({ row, shock }: { row: OutlookRow | null; shock: Shock }) {
  const factors = row?.factors ?? [];
  const d = shock.direction;
  const flat = d === null || Math.abs(d) <= 0.3;
  return (
    <section className="smx-card" aria-label="key factors">
      <h3 className="smx-title">
        Key factors
        <Hint text="Each part's share of the trend score, so they add up to it: the EMA stack counts half, RSI and swing structure a fifth each, VWAP a tenth." />
      </h3>
      {factors.length === 0 ? (
        <p className="smx-empty">No chart to break down</p>
      ) : (
        <ul className="smx-factors">
          {factors.map((f) => (
            <li key={f.key}>
              <span>{f.label}</span>
              <span className="smx-fbar" aria-hidden>
                <i className={f.contribution >= 0 ? 'up' : 'down'} style={{ width: `${Math.min(100, (Math.abs(f.contribution) / 0.5) * 100)}%` }} />
              </span>
              <b className={f.contribution >= 0 ? 'smx-up' : 'smx-down'}>{signed(f.contribution)}</b>
            </li>
          ))}
        </ul>
      )}
      <p
        className="smx-foot"
        title={shock.directionParts.map((p) => `${p.name}: ${signed(p.value)}`).join(' · ') || undefined}
      >
        Options flow: {flat ? 'no clear side' : `${d! > 0 ? 'upside' : 'downside'} ${Math.round(Math.abs(d!) * 100)}%`}
      </p>
    </section>
  );
}

/**
 * Spot on a line between the two thresholds the probability outlook counted:
 * the band options imply (dashed) and the band BTC usually moves (filled).
 */
function RangeCard({ snap, row, shock, label }: { snap: SnapshotMeta; row: OutlookRow | null; shock: Shock; label: string }) {
  const t = (shock.odds?.thresholdPct ?? 1) / 100;
  const spot = snap.spot;
  const lo = spot * (1 - t);
  const hi = spot * (1 + t);
  const implied = row?.impliedUsd ?? snap.expectedMove ?? null;
  const usual = row?.measured68Pct == null ? null : (spot * row.measured68Pct) / 100;
  const edgeLo = Math.min(lo, spot - (implied ?? 0), spot - (usual ?? 0));
  const edgeHi = Math.max(hi, spot + (implied ?? 0), spot + (usual ?? 0));
  const pad = (edgeHi - edgeLo) * 0.03;
  const x = (v: number) => `${((v - (edgeLo - pad)) / (edgeHi - edgeLo + 2 * pad)) * 100}%`;
  const span = (a: number, b: number) => ({ left: x(a), width: `calc(${x(b)} - ${x(a)})` });

  return (
    <section className="smx-card smx-range" aria-label="price range">
      <h3 className="smx-title">
        Price range ({label.toUpperCase()})
        <Hint text="Dashed: the move options imply for this window. Filled: the move BTC made two times in three. The dots are the thresholds the probability outlook counted." />
      </h3>
      <div className="smx-rline" role="img" aria-label={`spot ${fmtStrike(Math.round(spot))} between ${fmtStrike(Math.round(lo))} and ${fmtStrike(Math.round(hi))}`}>
        <i className="axis" />
        {usual !== null && <i className="usual" style={span(spot - usual, spot + usual)} />}
        {implied !== null && <i className="implied" style={span(spot - implied, spot + implied)} />}
        <i className="dot down" style={{ left: x(lo) }} />
        <i className="dot up" style={{ left: x(hi) }} />
        <i className="spot" style={{ left: x(spot) }}>
          <span><small>Spot</small>{fmtStrike(Math.round(spot))}</span>
        </i>
      </div>
      <div className="smx-rlabels">
        <span className="lo"><b>{fmtStrike(Math.round(lo))}</b><small>−{(t * 100).toFixed(1)}%</small></span>
        <span className="mid">
          {implied !== null && <>← Expected move ±{usd(implied)} →<b>{fmtStrike(Math.round(spot - implied))} – {fmtStrike(Math.round(spot + implied))}</b></>}
        </span>
        <span className="hi"><b>{fmtStrike(Math.round(hi))}</b><small>+{(t * 100).toFixed(1)}%</small></span>
      </div>
    </section>
  );
}

/** "more calls open", "more puts traded", "about even": a ratio in the words people use. */
export function sideWords(pcr: number, verb: 'open' | 'traded'): string {
  return pcr < 0.9 ? `more calls ${verb}` : pcr > 1.1 ? `more puts ${verb}` : 'about even';
}

/** Open interest at a strike, short: 145,000 reads as 145k. */
const oiShort = (v: number): string => (v >= 1_000_000 ? `${(Math.round(v / 100_000) / 10).toFixed(1)}m` : v >= 1_000 ? `${Math.round(v / 1_000)}k` : String(Math.round(v)));

function Stat({ label, value, foot, sub, hint }: { label: string; value: string; foot: string; sub?: string; hint: string }) {
  return (
    <div className="smx-stat" title={hint}>
      <span className="smx-stat-label">{label}</span>
      <b className="smx-stat-value">{value}</b>
      <span className="smx-stat-foot">{foot}</span>
      {sub && <span className="smx-stat-foot">{sub}</span>}
    </div>
  );
}
