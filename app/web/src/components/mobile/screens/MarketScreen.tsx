import { countdown, stamp } from '@/lib/format';
import { usePhone } from '@/components/mobile/phone-context';
import { Empty, Panel, Pill, Row, Rows } from '@/components/mobile/parts';

/**
 * Market (6 Oct 2026): BTC as the desk sees it -- the perp's last trade, mark and index, the day's change and
 * range, funding and open interest -- and the next daily settlement. From the glance the shell already reads: no
 * chart and no extra call; the desk has the chart.
 */

/** The next 17:30 IST (12:00 UTC): the daily contract's settlement, then Delta's launch auction to 17:34. */
export function nextSettlement(now: number): number {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0);
  return now < today ? today : today + 86_400_000;
}

const n0 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-US'));

export function MarketScreen() {
  const p = usePhone();
  const g = p.glance;
  const t = g?.btc.perp ?? null;
  const settles = nextSettlement(p.now);
  const inAuction = p.now >= settles - 86_400_000 && p.now < settles - 86_400_000 + 4 * 60_000;
  const change = t?.change24hPct ?? null;

  return (
    <>
      <Panel title="BTC perpetual">
        {!g ? <Empty>Reading the market…</Empty> : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[28px] font-semibold tabular-nums">{n0(t?.last ?? g.btc.perpMark)}</span>
              {change !== null && (
                <span className={change > 0 ? 'text-[15px] font-semibold text-[var(--up)]' : change < 0 ? 'text-[15px] font-semibold text-[var(--down)]' : 'text-[15px]'}>
                  {change > 0 ? '+' : ''}{change.toFixed(2)}% 24h
                </span>
              )}
            </div>
            <Rows>
              <Row label="Mark">{n0(t?.mark ?? g.btc.perpMark)}</Row>
              <Row label="Index (BTC)">{n0(t?.spot ?? g.btc.spot)}</Row>
              <Row label="24h high / low">{n0(t?.high24h)} / {n0(t?.low24h)}</Row>
              <Row label="Funding">{t?.fundingRate != null ? `${t.fundingRate >= 0 ? '+' : ''}${t.fundingRate.toFixed(4)}%` : '—'}</Row>
              <Row label="Open interest">{t?.oiUsd != null ? `$${(t.oiUsd / 1e6).toFixed(1)}M` : '—'}</Row>
              <Row label="As of">{t ? stamp(t.at) : '—'}</Row>
            </Rows>
          </>
        )}
      </Panel>

      <Panel title="Daily options">
        <Rows>
          <Row label="Next settlement">17:30 IST · {countdown(settles, p.now)}</Row>
          <Row label="Now">{inAuction ? <Pill tone="warn">LAUNCH AUCTION</Pill> : <Pill tone="up">TRADING</Pill>}</Row>
          <Row label="Option prices">{g ? (g.boardAgeMs === null ? 'none yet' : `${Math.round(g.boardAgeMs / 1000)} s old`) : '…'}</Row>
          <Row label="Perp tape">{g ? (g.tapeAgeMs === null ? 'none yet' : `${Math.round(g.tapeAgeMs / 1000)} s old`) : '…'}</Row>
        </Rows>
        <p className="m-0 mt-2 text-[12px] text-muted-foreground">From 17:30 to 17:34 IST Delta runs the new daily contract's launch auction.</p>
      </Panel>
    </>
  );
}
