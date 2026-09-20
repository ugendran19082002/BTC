import type { ChainResponse, Leg } from '@/types/desk';
import type { OiPulse } from '@/api/desk';
import {
  noTradeCard, odds, orderEstimate, premiumAnalysis,
  type BothAssessment, type ExpectedMove, type Gate, type IvRv, type MtfConsensus, type SideAssessment, type SideChoice,
} from '@/lib/overview';
import { fmt, Panel, Row, Tag } from './parts';

/**
 * The decision, as four strategies side by side: SELL CE, SELL PE, BOTH
 * SIDES, NO TRADE. One is the desk's answer; the other three say why not.
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
export function DecisionCards({ data, sides, both, choice, ready, iv, em, mtf, contracts, leverage, now, entryIst, onSelect, oi = null }: {
  data: ChainResponse; sides: SideAssessment[]; both: BothAssessment; choice: SideChoice; ready: { gates: Gate[] }; oi?: OiPulse | null;
  iv: IvRv | null; em: ExpectedMove; mtf: MtfConsensus; contracts: number; leverage: number; now: number; entryIst: string;
  onSelect: (cp: 'C' | 'P', strike: number) => void;
}) {
  const ce = sides.find((s) => s.side === 'CE')!, pe = sides.find((s) => s.side === 'PE')!;
  const tone = choice.side === 'NO_TRADE' ? 'down' : choice.side === 'BOTH' ? 'up' : 'accent';
  return (
    <Panel title="Strategy decision" right={<Tag tone={tone}>Desk side: {choice.side.replace('_', ' ')}</Tag>}>
      <p className="ov-summary"><b>{choice.side === 'NO_TRADE' ? 'No trade' : choice.side === 'BOTH' ? 'Sell both sides' : `Sell ${choice.side}`}</b> — {choice.why}.</p>
      <div className="ov-cards4">
        <SellCard side={ce} data={data} iv={iv} em={em} mtf={mtf} contracts={contracts} leverage={leverage} chosen={choice.side === 'CE' || choice.side === 'BOTH'} onSelect={onSelect} oi={oi} />
        <SellCard side={pe} data={data} iv={iv} em={em} mtf={mtf} contracts={contracts} leverage={leverage} chosen={choice.side === 'PE' || choice.side === 'BOTH'} onSelect={onSelect} oi={oi} />
        <BothCard both={both} ce={ce} pe={pe} data={data} mtf={mtf} contracts={contracts} leverage={leverage} chosen={choice.side === 'BOTH'} />
        <NoTradeCardView sides={sides} gates={ready.gates} now={now} entryIst={entryIst} chosen={choice.side === 'NO_TRADE'} />
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

function SellCard({ side: s, data, iv, em, mtf, contracts, leverage, chosen, onSelect, oi: pulse }: {
  side: SideAssessment; data: ChainResponse; iv: IvRv | null; em: ExpectedMove; mtf: MtfConsensus; contracts: number; leverage: number; chosen: boolean;
  onSelect: (cp: 'C' | 'P', strike: number) => void; oi: OiPulse | null;
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
            <Row label="Selected strike" value={<button type="button" className="ov-linkbtn" onClick={() => onSelect(leg.cp, leg.strike)}>{fmt.n(leg.strike)} {s.side}</button>} />
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

function BothCard({ both, ce, pe, data, mtf, contracts, leverage, chosen }: {
  both: BothAssessment; ce: SideAssessment; pe: SideAssessment; data: ChainResponse; mtf: MtfConsensus; contracts: number; leverage: number; chosen: boolean;
}) {
  const credit = (l: Leg | null) => {
    const px = l ? (l.bid ?? l.sellPrice ?? l.mark) : null;
    return l && px !== null ? orderEstimate(l.cp, l.strike, px, data.snapshot.spot, leverage, contracts).creditUsd : null;
  };
  const cCe = credit(ce.leg), cPe = credit(pe.leg);
  const netCredit = cCe !== null && cPe !== null ? cCe + cPe : null;
  const regime = data.market?.regime ?? null;
  const rangeOk = regime === null ? null : /quiet|mixed|range|low/i.test(regime);
  const mtfOk = mtf.scored === 0 ? null : mtf.way === 'SIDE';
  const liqOk = gate(ce, 'Liquidity')?.ok === true && gate(pe, 'Liquidity')?.ok === true ? true : gate(ce, 'Liquidity')?.ok === false || gate(pe, 'Liquidity')?.ok === false ? false : null;
  const riskOk = gate(ce, 'Tail risk')?.ok === true && gate(pe, 'Tail risk')?.ok === true ? true : gate(ce, 'Tail risk')?.ok === false || gate(pe, 'Tail risk')?.ok === false ? false : null;
  const finals = [both.ceSafe, both.peSafe, riskOk, rangeOk, mtfOk, liqOk];
  const off = Boolean(ce.disabledBy || pe.disabledBy);
  const allowed = off ? false : finals.every((x) => x === true);
  const safe = (ok: boolean | null) => (ok === null ? <span className="ov-muted">—</span> : <span className={ok ? 'ov-up' : 'ov-down'}>{ok ? '✅' : '❌'}</span>);
  const sideBlock = (s: SideAssessment) => {
    const o = s.leg ? odds(s.leg) : null;
    return (
      <Section name={`${s.side} side${s.leg ? ` · ${fmt.n(s.leg.strike)}` : ''}`}>
        <Row label={`${s.side} safe`} value={safe(s.side === 'CE' ? both.ceSafe : both.peSafe)} hint="At least one expected move out" />
        <Row label="P(expire OTM)" value={fmt.pct(o?.pOtm)} />
        <Row label="P(touch)" value={fmt.pct(o?.pTouch)} />
        <Row label="Gamma" value={s.gammaRisk ?? '—'} tone={s.gammaRisk === 'high' ? 'down' : s.gammaRisk === 'low' ? 'up' : undefined} />
      </Section>
    );
  };
  return (
    <div className={`ov-card4 ov-card4-both${chosen ? ' ov-card4-chosen' : ''}`}>
      <header><b>BOTH SIDES</b><Tag tone={allowed ? 'up' : 'down'}>{allowed ? 'ALLOWED' : 'NOT ALLOWED'}</Tag></header>
      {sideBlock(ce)}
      {sideBlock(pe)}
      <Section name="Combined">
        <Row label="Net credit" value={netCredit === null ? '—' : `$${netCredit.toFixed(2)}`} hint={`Both legs, ${contracts} contracts each, at the bid`} />
        <Row label="Combined delta" value={both.netDelta === null ? '—' : fmt.signed(both.netDelta, 2)} />
        <Row label="Combined gamma" value={both.netGamma === null ? '—' : `−${both.netGamma.toPrecision(2)}`} />
        <Row label="Combined theta" value={both.netTheta === null ? '—' : fmt.signed(-both.netTheta, 1)} hint="Per day, per BTC, as the short earns it" />
        <Row label="Combined vega" value={both.netVega === null ? '—' : fmt.signed(-both.netVega, 1)} />
        <Row label="Combined tail risk" value={both.combinedTailLossUsd === null ? '—' : `$${both.combinedTailLossUsd.toFixed(2)}`} tone="down" />
        <Row label="Combined margin" value={both.marginUsd === null ? '—' : `$${both.marginUsd.toFixed(2)}`} />
        <Row label="Combined expected P&L" value={both.combinedExpectedPnlUsd === null ? '—' : fmt.signed(both.combinedExpectedPnlUsd, 2)} />
      </Section>
      <Section name="Final gate">
        <Row label="CE safety" value={pass(both.ceSafe)} />
        <Row label="PE safety" value={pass(both.peSafe)} />
        <Row label="Combined risk" value={pass(riskOk)} hint="Both tails within the limit" />
        <Row label="Range regime" value={pass(rangeOk)} hint={regime ? `Regime: ${regime}` : undefined} />
        <Row label="MTF" value={<>{pass(mtfOk)} <small className="ov-muted">{mtf.text}</small></>} hint="Both sides want the timeframes not to lean" />
        <Row label="Liquidity" value={pass(liqOk)} />
      </Section>
      <footer>
        <span><b>BOTH SELL</b></span>
        <Tag tone={allowed ? 'up' : 'down'}>{allowed ? '✅ ALLOWED' : '❌ NOT ALLOWED'}</Tag>
      </footer>
    </div>
  );
}

function NoTradeCardView({ sides, gates, now, entryIst, chosen }: { sides: SideAssessment[]; gates: Gate[]; now: number; entryIst: string; chosen: boolean }) {
  const c = noTradeCard(sides, gates, now, entryIst);
  return (
    <div className={`ov-card4 ov-card4-none${chosen ? ' ov-card4-chosen' : ''}`}>
      <header><b>NO TRADE</b><Tag tone={chosen ? 'down' : 'muted'}>{chosen ? '🔴 WAIT' : 'not the answer'}</Tag></header>
      <Section name="Why">
        <Row label="Confidence" value={c.confidence} tone={c.confidence === 'High' ? 'down' : c.confidence === 'Medium' ? 'warn' : 'muted'} hint="How many hard gates stand in the way on the better side" />
        {c.reasons.length === 0 ? <p className="ov-empty">Nothing is blocking a trade.</p> : (
          <ul className="ov-reasons">{c.reasons.map((r) => <li key={r}>❌ {r}</li>)}</ul>
        )}
      </Section>
      <Section name="Next action">
        <Row label="Next recheck" value={<b>{c.recheckIst} IST</b>} hint="The entry window when it has not opened; the next five-minute mark otherwise" />
      </Section>
      <Section name="What can change">
        {c.waitFor.length === 0 ? <p className="ov-empty">—</p> : <ul className="ov-reasons ov-waitfor">{c.waitFor.map((w) => <li key={w}>• {w}</li>)}</ul>}
      </Section>
      <footer>
        <span><b>{chosen ? 'Stand aside' : 'Not needed'}</b></span>
        <Tag tone={chosen ? 'down' : 'muted'}>{chosen ? '🔴 WAIT' : '—'}</Tag>
      </footer>
    </div>
  );
}
