import type { BreakRisk } from '@/api/desk';
import { oneIn, strikeRisk, type StrikeRisk } from '@/lib/break-risk';
import { fmt, Panel, Tag } from './parts';

const IST = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const minutesLeft = (until: number, now: number) => Math.max(0, Math.ceil((until - now) / 60_000));

export type WatchedStrike = { strike: number; cp: 'C' | 'P'; held: boolean };

const LEVEL_WORDS: Record<StrikeRisk['level'], { text: string; tone: 'down' | 'warn' | 'up' }> = {
  IN_THE_WAY: { text: 'In the way', tone: 'down' },
  WATCH: { text: 'Watch', tone: 'warn' },
  CLEAR: { text: 'Clear', tone: 'up' },
};

/**
 * The momentum card, rebuilt as what the history supports (26 Sep 2026).
 *
 * The owner asked for a big-move signal with a stop and a target. Replayed
 * over two and a half years, the break call is a coin flip for direction and
 * loses money traded either way after fees -- so this card never says buy or
 * sell. What it does say is measured: after a break the next hour is bigger
 * than usual, by how much, and how often an hour like it reached each short
 * strike on the screen. Those are the numbers a seller can act on.
 */
export function BreakRiskCard({ risk, now, strikes, id }: {
  risk: BreakRisk | null | undefined;
  now: number;
  /** Short strikes held, then the desk's picks: what a move would hurt. */
  strikes: readonly WatchedStrike[];
  id?: string;
}) {
  if (risk === undefined) {
    return <Panel title="Big move risk" id={id}><p className="ov-empty">Reading the last hour's bars…</p></Panel>;
  }
  if (risk === null || risk.until <= now) {
    return (
      <Panel title="Big move risk" id={id} right={<Tag tone="muted">Quiet</Tag>}>
        <p className="ov-br-quiet">No 15m, 30m or 1h breakout or breakdown in the last hour.</p>
        <p className="ov-foot">
          When one fires, this card shows how big the next hour measured after breaks like it (2024–2026), and how
          often that reached each of your short strikes. It never calls a direction: measured, breaks were a coin flip.
        </p>
      </Panel>
    );
  }

  const up = risk.side === 'UP';
  const arrow = up ? '↑' : '↓';
  const sign = up ? 1 : -1;
  const priceAt = (pts: number, way: 1 | -1) => fmt.n(Math.round(risk.entry + way * pts));
  const rows = strikes.map((s) => ({ ...s, ...strikeRisk(risk, s.strike, s.cp) }));
  const years = Object.entries(risk.keptGoingByYear).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Panel
      title={`Big move risk · ${risk.tf} ${up ? 'breakout' : 'breakdown'} ${arrow}`}
      name="Big move risk"
      id={id}
      className="ov-br-active"
      right={<Tag tone="warn">{minutesLeft(risk.until, now)}m left</Tag>}
    >
      <p className="ov-br-when">
        Closed {up ? 'over' : 'under'} <b>{fmt.n(risk.level)}</b> at {IST.format(new Date(risk.at))} IST ·
        risk window until <b>{IST.format(new Date(risk.until))}</b>
      </p>

      <div className="ov-br-head">
        <div>
          <span className="ov-br-label">Expect a bigger hour</span>
          <b className="ov-br-big">±{fmt.n(risk.eitherPts[0])} pts</b>
          <span className="ov-br-sub">typical · usual hour ±{fmt.n(risk.baselinePts[0])} ({risk.bigger >= 0 ? '+' : ''}{Math.round(risk.bigger * 100)}%)</span>
        </div>
        <div>
          <span className="ov-br-label">1 in 10 hours</span>
          <b className="ov-br-big">±{fmt.n(risk.eitherPts[1])} pts</b>
          <span className="ov-br-sub">or more, either way</span>
        </div>
        <div>
          <span className="ov-br-label">Direction</span>
          <b className="ov-br-big ov-muted">Coin flip</b>
          <span className="ov-br-sub" title={years.map(([y, v]) => `${y}: ${Math.round(v.keptGoing * 100)}% of ${v.n}`).join(' · ')}>
            {Math.round(risk.keptGoing * 100)}% kept going {arrow}
          </span>
        </div>
      </div>

      <table className="ov-br-zones">
        <caption>Where the hour reached, from {fmt.n(risk.entry)}</caption>
        <thead><tr><th /><th>1 in 2</th><th>1 in 4</th><th>1 in 10</th></tr></thead>
        <tbody>
          <tr>
            <th scope="row" className={up ? 'ov-up' : 'ov-down'}>{arrow} with the break</th>
            {[0, 1, 2].map((q) => <td key={q}>{priceAt(risk.withPts[q]!, sign as 1 | -1)}</td>)}
          </tr>
          <tr>
            <th scope="row" className={up ? 'ov-down' : 'ov-up'}>{up ? '↓' : '↑'} against it</th>
            {[0, 1, 2].map((q) => <td key={q}>{priceAt(risk.againstPts[q]!, -sign as 1 | -1)}</td>)}
          </tr>
        </tbody>
      </table>

      {rows.length > 0 && (
        <ul className="ov-br-strikes" aria-label="Your strikes">
          {rows.map((r) => {
            const w = LEVEL_WORDS[r.level];
            return (
              <li key={`${r.cp}${r.strike}`}>
                <span>
                  <b>{fmt.n(r.strike)} {r.cp === 'C' ? 'CE' : 'PE'}</b>
                  <small className="ov-muted">{r.held ? ' · short' : ' · desk pick'}</small>
                </span>
                <span className="ov-muted">{r.distance <= 0 ? 'already through' : `${fmt.n(Math.round(r.distance))} pts away`}</span>
                <span>{oneIn(r.chance)} reached it</span>
                <Tag tone={w.tone}>{w.text}</Tag>
              </li>
            );
          })}
        </ul>
      )}
      {rows.some((r) => r.level === 'IN_THE_WAY' && r.held) && (
        <p className="ov-br-act">A short strike is inside the 1-in-4 zone for this hour: consider closing, rolling or hedging it.</p>
      )}

      <p className="ov-foot">
        Measured on {fmt.n(risk.n)} {risk.tf} breaks, {risk.from} → {risk.to}, the hour after each break bar closed.
        Not a trade signal: traded either way, breaks lost money after fees.
      </p>
    </Panel>
  );
}
