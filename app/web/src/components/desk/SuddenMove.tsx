import type { LucideIcon } from 'lucide-react';
import {
  Zap, Activity, BarChart3, Waves, TrendingUp, TrendingDown, Minus, Info,
} from 'lucide-react';
import type { MarketRead, OptionStructure, SnapshotMeta, SuddenMove as Shock } from '@/types/desk';
import { strike as fmtStrike } from '@/lib/format';

const BAND = {
  normal: { label: 'Normal', note: 'Nothing unusual on the tape' },
  watch: { label: 'Watch', note: 'Something is stirring' },
  high: { label: 'High risk', note: 'Abnormal move possible in the next few hours' },
  sudden: { label: 'Sudden move', note: 'A move is under way' },
} as const;

type Tone = 'plain' | 'warn' | 'bad' | 'up' | 'down';

const compact = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—'
    : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k`
        : n.toFixed(0);

/**
 * The risk out of a hundred, drawn as an arc.
 *
 * A number on its own has no scale — 72 means nothing until you can see how
 * much of the dial it is. The number stays inside it: the arc is for the
 * glance, the figure for the decision.
 */
function Gauge({ score, tone }: { score: number; tone: Tone }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * c;
  return (
    <svg viewBox="0 0 64 64" className={`smr-gauge smr-${tone}`} role="img" aria-label={`${score} out of 100`}>
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      <circle
        cx="32" cy="32" r={r}
        fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${filled} ${c - filled}`}
        transform="rotate(-90 32 32)"
      />
      <text x="32" y="33" textAnchor="middle" fontSize="17" fontWeight="700" fill="currentColor">
        {score}
      </text>
      <text x="32" y="45" textAnchor="middle" fontSize="8" fill="var(--dim)">/100</text>
    </svg>
  );
}

/**
 * A reading: the headline, the two numbers behind it, and what to call it.
 *
 * The supporting pair is not decoration. "3.2×" is unreadable without "12.4k
 * against a 3.8k median" beside it — a ratio says how unusual something is and
 * says nothing about whether it is worth anything.
 */
function Reading({
  icon: Icon, label, headline, now, before, chip, tone = 'plain', hint,
}: {
  icon: LucideIcon;
  label: string;
  headline: string;
  now: string;
  before: string;
  chip: string | null;
  tone?: Tone;
  hint: string;
}) {
  return (
    <div className={`smr-card smr-${tone}`}>
      <div className="smr-card-head">
        <span className="smr-card-label">{label}</span>
        <span className="smr-card-icon" title={hint}><Info size={11} aria-hidden /></span>
      </div>
      <div className="smr-card-value">
        <Icon size={16} aria-hidden />
        <b>{headline}</b>
      </div>
      <div className="smr-card-rows">
        <span>{now}</span>
        <span>{before}</span>
      </div>
      {chip && <span className="smr-chip">{chip}</span>}
    </div>
  );
}

/** One figure in the market-data strip. */
function Datum({ label, value, foot, tone }: {
  label: string; value: string; foot?: string; tone?: Tone;
}) {
  return (
    <div className="smr-datum">
      <span className="smr-datum-label">{label}</span>
      <span className={`smr-datum-value smr-${tone ?? 'plain'}`}>{value}</span>
      {foot && <span className="smr-datum-foot">{foot}</span>}
    </div>
  );
}

const part = (shock: Shock, name: string) => shock.parts.find((p) => p.name === name) ?? null;

/**
 * Whether something is happening right now — five readings, the market behind
 * them, and how often a move like this has actually followed.
 *
 * ## What it is, and what it is not
 *
 * A short-premium desk loses on the days that move, so "is this one of those
 * days" is worth asking even when the answer cannot be acted on mechanically.
 * Every figure here is observable: how far BTC has moved against how far it was
 * *priced* to move, how busy the tape is against its own median, whether
 * volatility is repricing, and which way the pressure points.
 *
 * The probabilities at the bottom are counted off 105,120 measured five-minute
 * windows in `chain.db`, not assumed from a distribution — and the horizon
 * shown is the one actually read.
 *
 * **Nothing on the trading side reads any of it.** None of these weights has
 * been through the cross-period screen the premium floor and the RSI gate went
 * through, and the repo keeps a table of things that looked excellent over one
 * period and reversed over the next.
 *
 * Direction is the weakest reading and is drawn as pressure rather than as a
 * forecast: over those same windows the chance BTC finishes higher never moved
 * further than 0.6 points from a coin flip at any horizon out to twelve hours.
 */
export function SuddenMove({
  shock,
  snap,
  structure,
  market,
}: {
  shock: Shock;
  snap: SnapshotMeta;
  structure: OptionStructure;
  market: MarketRead | null;
}) {
  if (shock.score === null) return null;

  const band = BAND[shock.band];
  const riskTone: Tone = shock.band === 'sudden' || shock.band === 'high' ? 'bad'
    : shock.band === 'watch' ? 'warn' : 'up';

  const flat = shock.direction === null || Math.abs(shock.direction) <= 0.3;
  const Dir = flat ? Minus : shock.direction! > 0 ? TrendingUp : TrendingDown;
  const dirTone: Tone = flat ? 'plain' : shock.direction! > 0 ? 'up' : 'down';

  const move = part(shock, 'Move against expected');
  const volume = part(shock, 'Volume spike');
  const iv = part(shock, 'Volatility repricing');

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <section className={`smr smr-band-${shock.band}`} aria-label="sudden move analytics">
      <header className="smr-top">
        <span className="smr-title">
          <Zap size={16} aria-hidden />
          Sudden move analytics
        </span>
        <span className="smr-sub">
          Reads price, volume, volatility and the option board for an abnormal move
        </span>
        <span className="smr-live">{snap.live ? 'Live' : 'Snapshot'}</span>
      </header>

      <div className="smr-cards">
        <div className={`smr-card smr-risk smr-${riskTone}`}>
          <div className="smr-card-head">
            <span className="smr-card-label">Sudden-move risk</span>
          </div>
          <div className="smr-risk-body">
            <Gauge score={shock.score} tone={riskTone} />
            <span className="smr-risk-words">
              <b>{band.label}</b>
              <small>{band.note}</small>
            </span>
          </div>
        </div>

        <Reading
          icon={Waves}
          label="Move against expected"
          headline={move?.detail?.headline ?? '—'}
          now={move?.detail?.now ?? 'No 5-minute range to read'}
          before={move?.detail?.before ?? 'No volatility to price it from'}
          chip={move?.detail ? (move.value >= 0.5 ? 'Above expected' : 'Within expected') : null}
          tone={move?.detail && move.value >= 0.5 ? 'warn' : 'plain'}
          hint="The last five minutes' range against what that window was priced to move: spot × volatility × √(hours ÷ 8760)."
        />

        <Reading
          icon={BarChart3}
          label="Volume spike"
          headline={volume?.detail?.headline ?? '—'}
          now={volume?.detail?.now ?? 'No bars to read'}
          before={volume?.detail?.before ?? 'No median to compare against'}
          chip={volume?.detail ? (volume.value >= 0.5 ? 'High activity' : 'Ordinary') : null}
          tone={volume?.detail && volume.value >= 0.5 ? 'warn' : 'plain'}
          hint="The newest 5-minute bar against the median of the twenty before it. The median, not the mean: one violent bar drags a mean up enough that the next no longer looks unusual."
        />

        <Reading
          icon={Activity}
          label="Volatility shock"
          headline={iv?.detail?.headline ?? '—'}
          now={iv?.detail?.now ?? 'No reading yet'}
          before={iv?.detail?.before ?? 'The desk records one every five minutes'}
          chip={iv?.detail ? (iv.value >= 0.4 ? 'Expanding' : 'Steady') : null}
          tone={iv?.detail && iv.value >= 0.4 ? 'warn' : 'plain'}
          hint="At-the-money implied volatility against what it was fifteen minutes ago. Expanding volatility is what hurts a short."
        />

        <div className={`smr-card smr-${dirTone}`}>
          <div className="smr-card-head">
            <span className="smr-card-label">Direction pressure</span>
            <span
              className="smr-card-icon"
              title="Where the tape is pushing now — not where it settles. Over 105,119 measured windows the chance BTC finishes higher never moved further than 0.6 points from a coin flip."
            >
              <Info size={11} aria-hidden />
            </span>
          </div>
          <div className="smr-card-value">
            <Dir size={16} aria-hidden />
            <b>
              {flat ? 'No clear side'
                : `${shock.direction! > 0 ? 'Upside' : 'Downside'} ${Math.round(Math.abs(shock.direction!) * 100)}%`}
            </b>
          </div>
          {shock.directionParts.length > 0 ? (
            <ul className="smr-bars">
              {shock.directionParts.map((p) => (
                <li key={p.name}>
                  <span className="smr-bar-label">{p.name}</span>
                  <span className="smr-bar">
                    <i
                      className={p.value >= 0 ? 'up' : 'down'}
                      style={{ width: `${Math.round(Math.abs(p.value) * 100)}%` }}
                    />
                  </span>
                  <span className="smr-bar-pct">{Math.round(Math.abs(p.value) * 100)}%</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="smr-card-rows"><span>Nothing readable points either way</span></div>
          )}
        </div>
      </div>

      {shock.reasons.length > 0 && (
        <ul className="smr-reasons">
          {shock.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}

      <div className="smr-strip">
        <div className="smr-data">
          <span className="smr-strip-title">Key market data</span>
          <div className="smr-data-grid">
            <Datum
              label="BTC spot"
              value={fmtStrike(Math.round(snap.spot))}
              foot={market?.return24h == null ? undefined
                : `${market.return24h >= 0 ? '+' : ''}${market.return24h.toFixed(2)}% 24h`}
              tone={market?.return24h == null ? 'plain' : market.return24h >= 0 ? 'up' : 'down'}
            />
            <Datum label="24h high" value={market?.high24h == null ? '—' : fmtStrike(Math.round(market.high24h))} />
            <Datum label="24h low" value={market?.low24h == null ? '—' : fmtStrike(Math.round(market.low24h))} />
            <Datum
              label="IV (ATM)"
              value={snap.atmIv === null ? '—' : `${(snap.atmIv * 100).toFixed(1)}%`}
            />
            <Datum
              label="Expected move"
              value={snap.expectedMove === null ? '—' : `±$${fmtStrike(Math.round(snap.expectedMove))}`}
              foot={snap.expectedMove === null ? undefined
                : `${fmtStrike(Math.round(snap.spot - snap.expectedMove))}–${fmtStrike(Math.round(snap.spot + snap.expectedMove))}`}
            />
            <Datum
              label="Puts per call"
              value={structure.pcrOi === null ? '—' : structure.pcrOi.toFixed(2)}
              tone="warn"
            />
            <Datum label="CE open" value={compact(structure.ceOi)} />
            <Datum label="PE open" value={compact(structure.peOi)} />
          </div>
        </div>

        {shock.odds && (
          <div className="smr-odds">
            <span className="smr-strip-title">
              How often a move like this followed
              <span
                className="smr-card-icon"
                title="Counted off 105,120 measured five-minute windows in chain.db — a frequency that happened, not a distribution that was assumed."
              >
                <Info size={11} aria-hidden />
              </span>
            </span>
            <div className="smr-odds-grid">
              <span className="smr-odd up">
                <small>Up more than {shock.odds.thresholdPct}%</small>
                <b>{pct(shock.odds.up)}</b>
              </span>
              <span className="smr-odd down">
                <small>Down more than {shock.odds.thresholdPct}%</small>
                <b>{pct(shock.odds.down)}</b>
              </span>
              <span className="smr-odd">
                <small>Either side</small>
                <b>{pct(shock.odds.either)}</b>
              </span>
            </div>
            <span className="smr-odds-foot">
              over the next {shock.odds.overMinutes >= 60
                ? `${Math.round(shock.odds.overMinutes / 60)} hours`
                : `${shock.odds.overMinutes} minutes`}, measured
            </span>
          </div>
        )}
      </div>

      <p className="smr-note">
        For information. Nothing on the trading side reads any of this — none of these weights
        has been measured across 2024, 2025 and 2026 the way the premium floor and the RSI gate
        were.
      </p>
    </section>
  );
}
