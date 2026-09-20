import type { ChainResponse } from '@/types/desk';
import type { OiPulse } from '@/api/desk';
import { odds, type ExpectedMove, type IvRv, type MtfConsensus, type SideAssessment, type SideChoice } from '@/lib/overview';
import { fmt, Panel, Row, Tag } from './parts';

/**
 * The decision, as the two sides side by side: SELL CE and SELL PE. The
 * desk's answer -- one of them, both, or no trade -- is the panel's tag and
 * its first line; the cards say why.
 *
 * Each card is a summary: the strike, its three odds, the gates as ticks
 * in the order a seller asks them (direction, touch, distance, premium,
 * gamma, liquidity, execution, tail, margin), the score, the last word.
 * The readings behind the ticks are on hover; the strike's details are on
 * the panels below.
 *
 * The strike on each card is the side's assessment: the desk's pick, or the
 * best strike through the finder's filters. Details of a strike live below,
 * on the selected-strike panels; the cards carry the decision only.
 */
export type StrikeOption = { key: string; strike: number | null; label: string };

export function DecisionCards({ data, sides, choice, iv, em, mtf, contracts, leverage, onSelect, oi = null, strikeOptions, cardStrike, onCardStrike }: {
  data: ChainResponse; sides: SideAssessment[]; choice: SideChoice; oi?: OiPulse | null;
  iv: IvRv | null; em: ExpectedMove; mtf: MtfConsensus; contracts: number; leverage: number;
  onSelect: (cp: 'C' | 'P', strike: number) => void;
  /** The strikes a card may be pointed at -- auto (the desk's or the finder's), the selected strike, the finder's top -- and the choice made. */
  strikeOptions?: (cp: 'C' | 'P') => StrikeOption[];
  cardStrike?: { C: number | null; P: number | null };
  onCardStrike?: (cp: 'C' | 'P', strike: number | null) => void;
}) {
  const ce = sides.find((s) => s.side === 'CE')!, pe = sides.find((s) => s.side === 'PE')!;
  const tone = choice.side === 'NO_TRADE' ? 'down' : choice.side === 'BOTH' ? 'up' : 'accent';
  return (
    <Panel title="Strategy decision" right={<Tag tone={tone}>Desk side: {choice.side.replace('_', ' ')}</Tag>}>
      <p className="ov-summary"><b>{choice.side === 'NO_TRADE' ? 'No trade' : choice.side === 'BOTH' ? 'Sell both sides' : `Sell ${choice.side}`}</b> — {choice.why}.</p>
      <div className="ov-cards4">
        <SellCard side={ce} data={data} iv={iv} em={em} mtf={mtf} contracts={contracts} leverage={leverage} chosen={choice.side === 'CE' || choice.side === 'BOTH'} onSelect={onSelect} oi={oi}
          options={strikeOptions?.('C')} chosenStrike={cardStrike?.C ?? null} onChoose={onCardStrike ? (k) => onCardStrike('C', k) : undefined} />
        <SellCard side={pe} data={data} iv={iv} em={em} mtf={mtf} contracts={contracts} leverage={leverage} chosen={choice.side === 'PE' || choice.side === 'BOTH'} onSelect={onSelect} oi={oi}
          options={strikeOptions?.('P')} chosenStrike={cardStrike?.P ?? null} onChoose={onCardStrike ? (k) => onCardStrike('P', k) : undefined} />
      </div>
      <p className="ov-foot">{data.best.why ?? ''} Side from the regime, the multi-timeframe consensus and each side's gates — never the score alone. A gate's reading is on hover; the strike's details are below.</p>
    </Panel>
  );
}

const gate = (s: SideAssessment, name: string) => s.gates?.find((g) => g.name === name) ?? null;

/** The card's last word: PREFERRED is the desk's side, WATCH passes with soft failures, NOT PREFERRED fails a gate, NOT ALLOWED is switched off. */
export const sideFinal = (c: SideAssessment) => (c.disabledBy ? 'NOT ALLOWED' : c.status === 'SELL' ? 'PREFERRED' : c.status === 'WATCH' ? 'WATCH' : 'NOT PREFERRED');


function SellCard({ side: s, data, iv, em, mtf, contracts, leverage, chosen, onSelect, oi: pulse, options, chosenStrike = null, onChoose }: {
  side: SideAssessment; data: ChainResponse; iv: IvRv | null; em: ExpectedMove; mtf: MtfConsensus; contracts: number; leverage: number; chosen: boolean;
  onSelect: (cp: 'C' | 'P', strike: number) => void; oi: OiPulse | null;
  options?: StrikeOption[]; chosenStrike?: number | null; onChoose?: (strike: number | null) => void;
}) {
  const leg = s.leg;
  const o = leg ? odds(leg) : null;
  const final = sideFinal(s);
  void data; void iv; void em; void contracts; void leverage; void pulse;
  return (
    <div className={`ov-card4 ov-card4-${s.side.toLowerCase()}${chosen ? ' ov-card4-chosen' : ''}`}>
      <header>
        <b>SELL {s.side}</b>
        <Tag tone={final === 'PREFERRED' ? 'up' : final === 'WATCH' ? 'warn' : final === 'NOT ALLOWED' ? 'down' : 'muted'}>{final}</Tag>
      </header>
      {!leg ? <p className="ov-empty">No out-of-the-money {s.side} strike with a price.</p> : (
        <>
          <Row label="Strike" value={
            options && onChoose ? (
              <select className="ov-select" aria-label={`${s.side} strike`} value={chosenStrike === null ? 'auto' : String(chosenStrike)}
                onChange={(e) => onChoose(e.target.value === 'auto' ? null : Number(e.target.value))} title="Which strike this card judges: auto (the desk's pick, or the finder's best once its filters are moved), the selected strike, or one of the finder's top five">
                {options.map((o) => <option key={o.key} value={o.strike === null ? 'auto' : String(o.strike)}>{o.label}</option>)}
              </select>
            ) : <button type="button" className="ov-linkbtn" onClick={() => onSelect(leg.cp, leg.strike)}>{fmt.n(leg.strike)} {s.side}</button>
          } />
          <Row label="Judging" value={<button type="button" className="ov-linkbtn" onClick={() => onSelect(leg.cp, leg.strike)}>{fmt.n(leg.strike)} {s.side}</button>} hint="Click to inspect this strike below" />
          <Row label="P(OTM) · touch · breach" value={`${fmt.pct(o?.pOtm)} · ${fmt.pct(o?.pTouch)} · ${fmt.pct(o?.pItm)}`} hint="Expire worthless · touch before expiry · expire beyond the strike" />
          <ul className="ov-gates ov-gates-1">
            {(['Direction', 'MTF consensus', 'PoT', 'Distance / EM', 'IV − RV', 'Gamma', 'Liquidity', 'Execution', 'Tail risk', 'Margin'] as const).map((name) => {
              const g = gate(s, name);
              return (
                <li key={name} className={g?.ok === true ? 'ok' : g?.ok === false ? 'bad' : 'unknown'} title={g?.text}>
                  <span>{name === 'MTF consensus' ? `MTF · ${mtf.text}` : name}</span><b>{g?.ok === true ? '✅' : g?.ok === false ? '❌' : '?'}</b>
                </li>
              );
            })}
          </ul>
          <footer>
            <span><b>{s.side} SELL</b> <span className="ov-muted">score</span> <b>{s.score === null ? '—' : `${s.score.toFixed(1)} / 10`}</b> <small className="ov-muted">· {(s.gates ?? []).filter((g) => g.ok === true).length}/{(s.gates ?? []).length} pass</small></span>
            <Tag tone={final === 'PREFERRED' ? 'up' : final === 'WATCH' ? 'warn' : 'muted'}>{final === 'PREFERRED' ? '✅ Preferred' : final === 'WATCH' ? '⚠ Watch' : final === 'NOT ALLOWED' ? '⛔ Not allowed' : '⚠ Not preferred'}</Tag>
          </footer>
        </>
      )}
    </div>
  );
}
