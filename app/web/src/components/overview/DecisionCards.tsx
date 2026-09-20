import type { ChainResponse } from '@/types/desk';
import type { OiPulse } from '@/api/desk';
import {
  odds, orderEstimate, premiumAnalysis,
  type ExpectedMove, type IvRv, type MtfConsensus, type SideAssessment, type SideChoice,
} from '@/lib/overview';
import { fmt, Panel, Row, Tag } from './parts';

/**
 * The decision, as the two sides side by side: SELL CE and SELL PE. The
 * desk's answer -- one of them, both, or no trade -- is the panel's tag and
 * its first line; the cards say why.
 *
 * Each sell card reads top to bottom in the order a seller asks the
 * questions: where is the market (direction) -- will the strike hold
 * (expiry odds, touch, distance) -- is the premium worth it -- who is
 * positioned there (OI) -- what can hurt (gamma, tail) -- can it actually be
 * sold at that price (liquidity, execution) -- and the last word.
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
      <p className="ov-foot">{data.best.why ?? ''} Side from the regime, the multi-timeframe consensus and each side's gates — never the score alone. Click a card's strike to inspect it below.</p>
    </Panel>
  );
}

const pass = (ok: boolean | null | undefined) => (ok === true ? <b className="ov-up">PASS</b> : ok === false ? <b className="ov-down">FAIL</b> : <b className="ov-muted">?</b>);
const gate = (s: SideAssessment, name: string) => s.gates?.find((g) => g.name === name) ?? null;
const gateRow = (s: SideAssessment, name: string, label = name) => {
  const g = gate(s, name);
  return <Row key={name} label={label} value={pass(g?.ok)} hint={g?.text} />;
};

/** The card's last word: PREFERRED is the desk's side, WATCH passes with soft failures, NOT PREFERRED fails a gate, NOT ALLOWED is switched off. */
export const sideFinal = (c: SideAssessment) => (c.disabledBy ? 'NOT ALLOWED' : c.status === 'SELL' ? 'PREFERRED' : c.status === 'WATCH' ? 'WATCH' : 'NOT PREFERRED');

function Section({ name, children }: { name: string; children: React.ReactNode }) {
  return <div className="ov-card-sec"><h5>{name}</h5>{children}</div>;
}

function SellCard({ side: s, data, iv, em, mtf, contracts, leverage, chosen, onSelect, oi: pulse, options, chosenStrike = null, onChoose }: {
  side: SideAssessment; data: ChainResponse; iv: IvRv | null; em: ExpectedMove; mtf: MtfConsensus; contracts: number; leverage: number; chosen: boolean;
  onSelect: (cp: 'C' | 'P', strike: number) => void; oi: OiPulse | null;
  options?: StrikeOption[]; chosenStrike?: number | null; onChoose?: (strike: number | null) => void;
}) {
  const leg = s.leg;
  const o = leg ? odds(leg) : null;
  const pa = leg ? premiumAnalysis(leg, em) : null;
  const px = leg ? (leg.bid ?? leg.sellPrice ?? leg.mark) : null;
  const est = leg && px !== null ? orderEstimate(leg.cp, leg.strike, px, data.snapshot.spot, leverage, contracts) : null;
  const st = data.structure;
  const oi = s.side === 'CE' ? st.ceOi : st.peOi;
  const dOi = pulse ? (s.side === 'CE' ? pulse.ceChange1h : pulse.peChange1h) : null;
  const final = sideFinal(s);
  const regime = data.market?.regime ?? null;
  return (
    <div className={`ov-card4 ov-card4-${s.side.toLowerCase()}${chosen ? ' ov-card4-chosen' : ''}`}>
      <header>
        <b>SELL {s.side}</b>
        <Tag tone={final === 'PREFERRED' ? 'up' : final === 'WATCH' ? 'warn' : final === 'NOT ALLOWED' ? 'down' : 'muted'}>{final}</Tag>
      </header>
      {!leg ? <p className="ov-empty">No out-of-the-money {s.side} strike with a price.</p> : (
        <>
          <Section name="A · Direction">
            {gateRow(s, 'Direction')}
            <Row label="MTF consensus" value={<>{pass(gate(s, 'MTF consensus')?.ok)} <small className="ov-muted">{mtf.text}</small></>} hint={gate(s, 'MTF consensus')?.text} />
            <Row label="Market regime" value={regime ?? '—'} tone={regime && /up/i.test(regime) ? 'up' : regime && /down/i.test(regime) ? 'down' : 'muted'} />
          </Section>
          <Section name="B · Strike safety">
            <Row label="Strike" value={
              options && onChoose ? (
                <select className="ov-select" aria-label={`${s.side} strike`} value={chosenStrike === null ? 'auto' : String(chosenStrike)}
                  onChange={(e) => onChoose(e.target.value === 'auto' ? null : Number(e.target.value))} title="Which strike this card judges: auto (the desk's pick, or the finder's best once its filters are moved), the selected strike, or one of the finder's top five">
                  {options.map((o) => <option key={o.key} value={o.strike === null ? 'auto' : String(o.strike)}>{o.label}</option>)}
                </select>
              ) : null
            } />
            <Row label="Judging" value={<button type="button" className="ov-linkbtn" onClick={() => onSelect(leg.cp, leg.strike)}>{fmt.n(leg.strike)} {s.side}</button>} hint="Click to inspect this strike below" />
            <Row label="P(expire OTM)" value={fmt.pct(o?.pOtm)} tone="up" />
            <Row label="P(touch)" value={<>{fmt.pct(o?.pTouch)} {pass(gate(s, 'PoT')?.ok)}</>} hint={gate(s, 'PoT')?.text} />
            <Row label="P(breach)" value={fmt.pct(o?.pItm)} tone="down" hint="Expiring beyond the strike" />
            <Row label="Distance / EM" value={<>{s.emDistance === null ? '—' : `${s.emDistance.toFixed(2)}×`} {pass(gate(s, 'Distance / EM')?.ok)}</>} hint={gate(s, 'Distance / EM')?.text} />
          </Section>
          <Section name="C · Premium quality">
            <Row label="Premium (bid)" value={`${fmt.n(px, 1)}${est ? ` · $${est.creditUsd.toFixed(2)}` : ''}`} hint={`Per BTC, and the credit for ${contracts} contracts`} />
            <Row label="IV − RV" value={<>{iv ? `${fmt.signed(iv.spreadPts, 1)} pts` : '—'} {pass(gate(s, 'IV − RV')?.ok)}</>} hint={gate(s, 'IV − RV')?.text} />
            <Row label="Premium / EM" value={pa?.premiumPerEm == null ? '—' : fmt.pct(pa.premiumPerEm, 1)} />
            <Row label="Theta / premium" value={pa?.thetaPerPremiumDay == null ? '—' : `${fmt.pct(Math.min(9.99, pa.thetaPerPremiumDay), 0)} / day`} />
          </Section>
          <Section name="D · OI / chain">
            <Row label={`${s.side} OI`} value={fmt.n(oi)} />
            <Row label="ΔOI (1h)" value={dOi === null ? '—' : fmt.signed(dOi)} tone={dOi === null ? undefined : dOi > 0 ? 'up' : dOi < 0 ? 'down' : undefined} hint="The side's open interest over the hour, from the board's five-minute record" />
            <Row label="OI wall" value={<>{s.wallStrike === null ? '—' : `${fmt.n(s.wallStrike)} · ${s.wallDistanceStrikes === null ? '' : `${s.wallDistanceStrikes >= 0 ? '+' : ''}${s.wallDistanceStrikes} strikes`}`}</>}
              tone={s.wallDistanceStrikes === null ? undefined : s.wallDistanceStrikes >= 0 ? 'up' : 'down'} hint="Where the wall sits relative to the strike; beyond it is support" />
            <Row label="PCR (OI)" value={fmt.n(st.pcrOi, 2)} />
          </Section>
          <Section name="E · Risk">
            <Row label="Gamma" value={<>{s.gammaRisk ?? '—'} {pass(gate(s, 'Gamma')?.ok)}</>} />
            <Row label="Tail risk (2×EM)" value={<>{s.tailLossUsd === null ? '—' : `$${s.tailLossUsd.toFixed(2)}`} {pass(gate(s, 'Tail risk')?.ok)}</>} hint={gate(s, 'Tail risk')?.text} />
            {gateRow(s, 'Liquidity')}
            {gateRow(s, 'Execution')}
            <Row label="Margin" value={<>{s.marginUsd === null ? '—' : `$${s.marginUsd.toFixed(2)}`} {pass(gate(s, 'Margin')?.ok)}</>} hint={gate(s, 'Margin')?.text} />
          </Section>
          <footer>
            <span><b>{s.side} SELL</b> <span className="ov-muted">score</span> <b>{s.score === null ? '—' : `${s.score.toFixed(1)} / 10`}</b></span>
            <Tag tone={final === 'PREFERRED' ? 'up' : final === 'WATCH' ? 'warn' : 'muted'}>{final === 'PREFERRED' ? '✅ Preferred' : final === 'WATCH' ? '⚠ Watch' : final === 'NOT ALLOWED' ? '⛔ Not allowed' : '⚠ Not preferred'}</Tag>
          </footer>
        </>
      )}
    </div>
  );
}
