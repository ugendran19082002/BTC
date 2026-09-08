import { useEffect, useRef, useState } from 'react';

/**
 * Spot, ticking, and how far it has come.
 *
 * A number that changes every five seconds without saying so looks like a
 * number that is stuck, so each change is coloured for a moment -- green up,
 * red down.
 *
 * The move beside it is measured from when the contract opened, not from when
 * the page was opened. Page-open is an accident of when you happened to reload;
 * contract-open is the thing every other number on this desk is measured
 * against -- the strike distance, the expected move, the 733-day record. If the
 * contract's own figure has not arrived yet it falls back to the session, and
 * says which one it is showing either way.
 */
export function LivePrice({
  spot, live, sinceOpenUsd, sinceOpenPct,
}: {
  spot: number;
  live: boolean;
  /** Dollars moved since the contract opened at 05:30 IST. */
  sinceOpenUsd?: number | null;
  sinceOpenPct?: number | null;
}) {
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  const prev = useRef(spot);
  const opened = useRef(spot);

  useEffect(() => {
    if (spot === prev.current) return;
    setDir(spot > prev.current ? 'up' : 'down');
    prev.current = spot;
    // long enough to notice, short enough that the next tick is not fighting it
    const t = setTimeout(() => setDir(null), 900);
    return () => clearTimeout(t);
  }, [spot]);

  const fromContract = sinceOpenUsd !== null && sinceOpenUsd !== undefined;
  const move = fromContract ? sinceOpenUsd : spot - opened.current;
  // Always shown once it is measured against the contract. Hiding a move under a
  // dollar made the figure vanish for the first minutes of every contract, which
  // reads as broken rather than as "nothing has happened yet".
  const show = fromContract || Math.abs(move) >= 1;

  return (
    <span className={`liveprice${dir ? ' flash-' + dir : ''}`}>
      <i className={live ? 'dot on' : 'dot'} aria-hidden />
      <b>{spot.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</b>
      {show && (
        <span
          className={move >= 0 ? 'up' : 'down'}
          title={
            fromContract
              ? 'Since this contract opened at 05:30 IST — the point every strike on the board is measured from.'
              : 'Since you opened the page. The contract figure has not arrived yet.'
          }
        >
          {move >= 0 ? '+' : '−'}{Math.abs(move).toFixed(0)} pts
          {fromContract && sinceOpenPct != null && (
            <span className="pts">{sinceOpenPct >= 0 ? '+' : '−'}{Math.abs(sinceOpenPct * 100).toFixed(2)}%</span>
          )}
          {/*
            "+5 pts" on its own could be since anything -- the tick, the hour,
            the day. Naming the baseline is the whole difference between a
            number you can act on and one you have to ask about. It is the first
            thing to go on a narrow screen, where the tooltip still carries it.
          */}
          <span className="since">{fromContract ? 'since 05:30' : 'this session'}</span>
        </span>
      )}
    </span>
  );
}
