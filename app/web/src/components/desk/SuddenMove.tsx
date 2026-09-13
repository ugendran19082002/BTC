import { Activity, AlertTriangle, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { SuddenMove as Shock } from '@/types/desk';

const BAND_LABEL = {
  normal: 'Normal',
  watch: 'Watch',
  high: 'High risk',
  sudden: 'Sudden move',
} as const;

/**
 * Whether something is happening right now, and why.
 *
 * Five readings of the present tape — how far BTC has moved against how far it
 * was priced to, how busy the tape is against its own median, whether
 * volatility is repricing, whether open interest is moving, and how one-sided
 * the board is.
 *
 * ## It is quiet until it is not
 *
 * On an ordinary board this is one line. A warning that looks the same whether
 * or not there is anything to warn about is a warning nobody reads by the end
 * of the week, so the card only takes room once a reading is actually raised —
 * and then it says which ones, in words, because a risk number with no reasons
 * behind it is one nobody can check or argue with.
 *
 * Nothing on the trading side reads any of it. None of these weights has been
 * through the cross-period screen the premium floor and the RSI gate went
 * through, and this repo keeps a table of things that looked excellent over one
 * period and reversed over the next.
 */
export function SuddenMove({ shock }: { shock: Shock }) {
  if (shock.score === null) return null;

  const quiet = shock.band === 'normal';
  const Dir = shock.direction === null || Math.abs(shock.direction) <= 0.3
    ? Minus
    : shock.direction > 0 ? TrendingUp : TrendingDown;
  const dirTone = shock.direction === null || Math.abs(shock.direction) <= 0.3
    ? 'plain'
    : shock.direction > 0 ? 'up' : 'down';

  if (quiet) {
    return (
      <div className="shock shock-normal" aria-label="sudden move risk">
        <Activity size={14} aria-hidden />
        <span className="shock-quiet">
          Tape is ordinary — sudden-move risk <b>{shock.score}</b>/100.
        </span>
        <span className={`shock-dir shock-${dirTone}`}>
          <Dir size={13} aria-hidden /> {shock.directionLabel}
        </span>
      </div>
    );
  }

  return (
    <div className={`shock shock-${shock.band}`} aria-label="sudden move risk">
      <div className="shock-head">
        <AlertTriangle size={15} aria-hidden />
        <span className="shock-band">{BAND_LABEL[shock.band]}</span>
        <span className="shock-score">
          <b>{shock.score}</b>
          <small>/100</small>
        </span>
        <span className={`shock-dir shock-${dirTone}`}>
          <Dir size={13} aria-hidden /> {shock.directionLabel}
        </span>
      </div>

      <ul className="shock-reasons">
        {shock.reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>

      <div className="shock-parts">
        {shock.parts.map((p) => (
          <span key={p.name} className={p.note === null ? 'dim' : undefined}>
            {p.name}: <b>{p.note ?? 'no reading yet'}</b>
          </span>
        ))}
      </div>

      <p className="shock-note">
        For information. Nothing on the trading side reads this — none of these weights has
        been measured across 2024, 2025 and 2026 the way the premium floor and the RSI gate
        were.
      </p>
    </div>
  );
}
