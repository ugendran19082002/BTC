import { useMemo } from 'react';
import { usePhone } from '@/components/mobile/phone-context';
import { PositionCard } from '@/components/mobile/PositionCard';
import { Empty, Panel, Row, Rows, Rupees } from '@/components/mobile/parts';
import { positionRisk } from '@/lib/position-risk';
import { pct } from '@/lib/format';

/**
 * Positions (6 Oct 2026): every open position's live risk, the riskiest first -- anything wrong, then the stop
 * with the least room. Read only: no button here could close, edit or add, and the phone's session could not.
 */
export function PositionsScreen() {
  const p = usePhone();
  const s = p.status;
  const perpMark = p.perp;
  const open = useMemo(() => {
    const list = (s?.open ?? []).map((t) => ({ t, r: positionRisk(t, { alarms: s?.alarms, perpMark }) }));
    const room = (x: (typeof list)[number]) => (x.r.stop && x.r.stop.pct !== null && Number.isFinite(x.r.stop.pct) ? x.r.stop.pct : Infinity);
    return list
      .sort((a, b) => Number(b.r.problems.length > 0) - Number(a.r.problems.length > 0) || room(a) - room(b))
      .map((x) => x.t);
  }, [s, perpMark]);
  const total = (s?.open ?? []).reduce((n, t) => n + (t.live?.netIfClosedUsd ?? t.live?.unrealisedPnl ?? 0), 0);

  return (
    <>
      <Panel>
        <Rows>
          <Row label={`Open · ${s?.open.length ?? '…'}`} strong>{s ? <Rupees usd={total} signed size="sm" /> : '…'}</Row>
          <Row label="Margin used">
            {s?.marginUsedUsd != null && s.walletUsd ? `${pct(s.marginUsedUsd / s.walletUsd, 0)} of the wallet` : '—'}
          </Row>
        </Rows>
      </Panel>
      {!s ? <Panel><Empty>Reading positions…</Empty></Panel> : open.length === 0 ? <Panel><Empty>No open positions.</Empty></Panel> : (
        open.map((t) => (
          <PositionCard
            key={`${t.account?.id ?? ''}-${t.tradeId}`} trade={t} alarms={s.alarms} perpMark={perpMark} perpLive={p.perpLive}
            now={p.now} showAccount={p.shown === 'all'} onOpen={() => p.openTrade(t.tradeId)}
          />
        ))
      )}
    </>
  );
}
