import { useEffect, useRef, useState } from 'react';

/**
 * Spot, ticking, and how far it has come.
 *
 * A number that changes every five seconds without saying so looks like a
 * number that is stuck, so each change is coloured for a moment -- green up,
 * red down.
 *
 * The move beside it is measured from 05:30 IST, when the desk's day and the
 * morning contract began, not from when the page was opened. Page-open is an
 * accident of when you happened to reload; 05:30 is the thing every other
 * number on this desk is measured against -- the day's P&L next to it, the
 * strike distance, the expected move, the 733-day record. If the day's figure
 * has not arrived yet it falls back to the session, and says which one it is
 * showing either way.
 */
export function LivePrice({
  spot, live, sinceOpenUsd, sinceOpenPct, feed, updatedAt,
}: {
  spot: number;
  live: boolean;
  /** How updates are reaching this page: pushed as they happen, or asked for every second. */
  feed?: 'pushed' | 'polling';
  /** Dollars moved since the contract opened at 05:30 IST. */
  sinceOpenUsd?: number | null;
  sinceOpenPct?: number | null;
  /** When this value arrived. A live number without freshness is too easy to trust. */
  updatedAt?: number | null;
}) {
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  const [now, setNow] = useState(() => Date.now());
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

  useEffect(() => {
    if (!live || updatedAt === null || updatedAt === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [live, updatedAt]);

  const fromContract = sinceOpenUsd !== null && sinceOpenUsd !== undefined;
  const move = fromContract ? sinceOpenUsd : spot - opened.current;
  // Always shown once it is measured against the contract. Hiding a move under a
  // dollar made the figure vanish for the first minutes of every contract, which
  // reads as broken rather than as "nothing has happened yet".
  const show = fromContract || Math.abs(move) >= 1;
  const ageMs = live && updatedAt != null ? Math.max(0, now - updatedAt) : null;
  const stale = ageMs != null && ageMs > 10_000;
  const ageText = ageMs == null ? 'waiting for a tick' : ageMs < 1_000 ? 'updated just now' : `updated ${Math.floor(ageMs / 1_000)}s ago`;

  return (
    <span className={`liveprice${dir ? ' flash-' + dir : ''}${stale ? ' is-stale' : ''}`}>
      <i
        className={live ? 'dot on' : 'dot'}
        role="img"
        aria-label={!live ? 'a past board' : feed === 'polling' ? 'live, updated every second' : 'live, updated as it happens'}
        title={!live ? 'A past board: nothing here is moving.'
          : feed === 'polling' ? 'Live. Updates are fetched every second — the push connection is not available right now.'
            : 'Live. Updates arrive the moment they change.'}
      />
      <b>{spot.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</b>
      <span className="liveprice-age" title={stale ? 'The last LTP is older than 10 seconds. Treat distance and option calculations carefully until it refreshes.' : ageText}>
        {live ? (stale ? 'stale' : ageText) : 'past snapshot'}
      </span>
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
