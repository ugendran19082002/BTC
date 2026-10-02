import type { Candle } from '@/types/desk';
import type { LiveLtp } from '@/hooks/useStream';
import type { Leg } from '@/types/desk';
import type { PerpOiChange } from '@/api/desk';
import { useMemo } from 'react';
import { DeskHeader } from './DeskHeader';
import { EntrySection } from '@/components/desk/entry/EntrySection';
import type { TimeframeRow } from '@/types/entry';
import './desk-dashboard.css';

/*
 * The Live screen's top: a one-row header, then the entry section -- whose
 * two panels carry the desk's price charts. The full-width main chart went on
 * 30 Sep 2026: it ran an entry logic of its own beside the entry section's,
 * and the owner wanted one. Before that, the KPI strip, expiry prediction and
 * analysis grid went on 28 Sep 2026, and later that day the Big Momentum Signal card and the stats strip
 * (spot, perp, volume, OI, funding, IV, PCR). See docs/history/2026-09.md.
 */
export function DeskDashboard({
  bars,
  ltp = null,
  strikes = null,
  derivs = null,
  expiryLabel,
  hoursToExpiry,
  onAlerts,
  onSettings,
  controls,
  onTimeframes,
  belowEntry,
}: {
  bars: readonly Candle[];
  ltp?: LiveLtp | null;
  strikes?: { legs: readonly Leg[]; maxPain: number | null } | null;
  derivs?: { oi: PerpOiChange | null; funding: number | null } | null;
  expiryLabel?: string;
  hoursToExpiry?: number;
  onAlerts?: () => void;
  onSettings?: () => void;
  controls?: React.ReactNode;
  /** The entry board's timeframe rows, for a card elsewhere on the screen. */
  onTimeframes?: (rows: TimeframeRow[]) => void;
  /** Right under the entry setups: the signal strategies that trade them. */
  belowEntry?: React.ReactNode;
}) {
  const desk = useMemo(() => ({ bars5m: bars, ltp, strikes, derivs }), [bars, ltp, strikes, derivs]);
  return (
    <div className="desk-root" aria-label="BTC Live Desk">
      <DeskHeader
        expiryLabel={expiryLabel}
        hoursToExpiry={hoursToExpiry}
        onAlerts={onAlerts}
        onSettings={onSettings}
        controls={controls}
      />
      <EntrySection desk={desk} onTimeframes={onTimeframes} />
      {belowEntry}
    </div>
  );
}
