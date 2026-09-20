import type { ChainResponse, Leg } from '@/types/desk';
import {
  contractChecks, odds, type AgeItem, type BothAssessment, type MtfConsensus, type MustChange, type Persistence, type SideAssessment, type SideChoice,
} from '@/lib/overview';
import { sideFinal } from './DecisionCards';
import { fmt, Row, Tag } from './parts';

/**
 * The first thing a trader reads: the four outcomes with their last word,
 * the strike the answer is about and its odds, the MTF consensus, whether
 * the signal has persisted, whether the data and the contract allow an
 * order at all -- and, when the answer is NO TRADE, what must change and
 * when to look again. Everything below the strip is the working.
 */
export function FinalDecision({ data, sides, both, choice, leg, mtf, persist, freshness, must, now, onSelect, onSell }: {
  data: ChainResponse; sides: SideAssessment[]; both: BothAssessment; choice: SideChoice; leg: Leg | null; mtf: MtfConsensus;
  persist: Persistence; freshness: AgeItem[]; must: MustChange | null; now: number;
  onSelect: (cp: 'C' | 'P', strike: number) => void; onSell?: (l: Leg) => void;
}) {
  const ce = sides.find((s) => s.side === 'CE')!, pe = sides.find((s) => s.side === 'PE')!;
  const bothFinal = sides.some((s) => s.disabledBy) ? 'NOT ALLOWED' : both.status === 'BOTH' ? 'ALLOWED' : 'NOT ALLOWED';
  const rows: { name: string; final: string; on: boolean }[] = [
    { name: 'SELL CE', final: sideFinal(ce), on: choice.side === 'CE' || choice.side === 'BOTH' },
    { name: 'SELL PE', final: sideFinal(pe), on: choice.side === 'PE' || choice.side === 'BOTH' },
    { name: 'BOTH', final: bothFinal, on: choice.side === 'BOTH' },
    { name: 'NO TRADE', final: choice.side === 'NO_TRADE' ? 'WAIT' : '—', on: choice.side === 'NO_TRADE' },
  ];
  const mark = (r: { final: string; on: boolean }) => (r.on ? '✅' : r.final === '—' ? '·' : '❌');
  const pick = choice.side === 'CE' ? ce.leg : choice.side === 'PE' || choice.side === 'BOTH' ? pe.leg : leg;
  const o = pick ? odds(pick) : null;
  const stale = freshness.filter((a) => a.stale);
  const checks = contractChecks(data.snapshot, now);
  const contractOk = checks.every((c) => c.ok === true);
  const block = !data.snapshot.live || stale.length > 0 || !contractOk;
  const tone = choice.side === 'NO_TRADE' ? 'down' : choice.side === 'BOTH' ? 'up' : 'accent';
  return (
    <section className={`ov-final ov-final-${tone}`} aria-label="Final expiry sell decision">
      <div className="ov-final-head">
        <b>FINAL EXPIRY SELL DECISION</b>
        <Tag tone={tone}>{choice.side === 'NO_TRADE' ? 'NO TRADE' : choice.side === 'BOTH' ? 'SELL BOTH' : `SELL ${choice.side}`}</Tag>
        <Tag tone={persist.valid ? 'up' : 'warn'} >Signal persistence · {persist.text}</Tag>
        <Tag tone={block ? 'down' : 'up'}>{block ? 'ENTRY BLOCKED' : 'ENTRY OPEN'}</Tag>
      </div>
      <div className="ov-final-grid">
        <div className="ov-final-col">
          {rows.map((r) => (
            <Row key={r.name} label={<b>{r.name}</b>} value={<span className={r.on ? 'ov-up' : 'ov-muted'}>{mark(r)} {r.final}</span>} />
          ))}
        </div>
        <div className="ov-final-col">
          <Row label="Selected" value={pick ? <button type="button" className="ov-linkbtn" onClick={() => onSelect(pick.cp, pick.strike)}>{pick.cp === 'C' ? 'CE' : 'PE'} {fmt.n(pick.strike)}</button> : '—'} hint="The strike the answer is about; click to inspect it" />
          <Row label="Score" value={(() => { const s = choice.side === 'CE' ? ce : choice.side === 'PE' || choice.side === 'BOTH' ? pe : null; return s?.score == null ? '—' : `${s.score.toFixed(1)} / 10`; })()} hint="The desk's score for that strike — its measured record, not a confidence the desk has not measured" />
          <Row label="MTF" value={<span className={mtf.way === 'UP' ? 'ov-up' : mtf.way === 'DOWN' ? 'ov-down' : 'ov-muted'}>{mtf.text}</span>} />
          <Row label="P(expire OTM)" value={fmt.pct(o?.pOtm)} tone="up" />
          <Row label="P(touch)" value={fmt.pct(o?.pTouch)} />
          <Row label="P(breach)" value={fmt.pct(o?.pItm)} tone="down" />
          <Row label="P(premium < 10%)" value={o?.pOtm == null ? '—' : `≈ ${fmt.pct(o.pOtm)}`} hint="At settlement the premium is its intrinsic alone: under a tenth of today's premium is the same event as expiring OTM, to the nearest percent" />
          <Row label="P(premium < 5%)" value="not measured" tone="muted" hint="Needs weeks of the premium record (every strike, every five minutes, since 19 Sep 2026)" />
        </div>
        <div className="ov-final-col">
          <div className="ov-final-sub">Data</div>
          {freshness.map((a) => <Row key={a.key} label={a.label} value={<span className={a.stale ? 'ov-down' : 'ov-up'}>{a.text} {a.stale ? '⛔ BLOCK' : '✅'}</span>} />)}
          <div className="ov-final-sub">Contract</div>
          {checks.map((c) => <Row key={c.name} label={c.name} value={<span className={c.ok ? 'ov-up' : 'ov-down'}>{c.ok ? '✅' : '❌'} {c.text}</span>} />)}
        </div>
        {choice.side === 'NO_TRADE' && must && (
          <div className="ov-final-col ov-final-must">
            <div className="ov-final-sub">Why</div>
            {must.why.length === 0 ? <p className="ov-empty">No gate fails on the closest side; the regime and the horizons do not agree on a side.</p> : <ul className="ov-reasons">{must.why.map((w) => <li key={w}>❌ {w}</li>)}</ul>}
            <div className="ov-final-sub">To become tradable</div>
            {must.toTrade.length === 0 ? <p className="ov-empty">A side the regime and the horizons agree on.</p> : <ul className="ov-reasons">{must.toTrade.map((w) => <li key={w}>→ {w}</li>)}</ul>}
            <Row label="Next recheck" value={<b>{must.recheckIst} IST</b>} />
          </div>
        )}
        {choice.side !== 'NO_TRADE' && pick && onSell && data.snapshot.live && (
          <div className="ov-final-col ov-final-act">
            <button className="ov-place" disabled={block} onClick={() => onSell(pick)} title={block ? 'Entry is blocked: stale data or the contract is not tradable' : 'Opens the order ticket; every gate runs again on the server'}>
              Sell {fmt.n(pick.strike)} {pick.cp === 'C' ? 'CE' : 'PE'} via ticket
            </button>
            {!persist.valid && <p className="ov-foot">The side has not persisted yet ({persist.text}); a flip on one board is not a signal.</p>}
          </div>
        )}
      </div>
    </section>
  );
}
