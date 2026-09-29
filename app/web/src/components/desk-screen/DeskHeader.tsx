import React from 'react';

/**
 * The Live screen's header, in one row: who it is, that it is live, the
 * contract and its time left, then the controls.
 *
 * BTC spot and the timeframe buttons left on 28 Sep 2026: the price is in the
 * app bar above, and the chart carries its own timeframe picker, so each was
 * the same control twice.
 */
export function DeskHeader({
  expiryLabel,
  hoursToExpiry,
  controls,
}: {
  expiryLabel?: string;
  hoursToExpiry?: number;
  onAlerts?: () => void;
  onSettings?: () => void;
  controls?: React.ReactNode;
}) {
  const left = hoursToExpiry !== undefined && Number.isFinite(hoursToExpiry) && hoursToExpiry > 0 ? hoursToExpiry : null;
  const h = left === null ? 0 : Math.floor(left);
  const m = left === null ? 0 : Math.round((left - h) * 60);

  return (
    <header className="desk-header desk-header-row">
      <div className="desk-logo-box">
        <div className="desk-btc-icon">₿</div>
        <div className="desk-title-group">
          <h1>BTC Live Desk</h1>
          <span>Delta Exchange India · Options</span>
        </div>
      </div>

      <div className="desk-live-badge">
        <span className="desk-live-dot" />
        <span>LIVE</span>
      </div>

      {expiryLabel && (
        <div className="desk-expiry-pill">
          <span>Expiry {expiryLabel}</span>
          {left !== null && <span className="desk-expiry-countdown">{h}h {String(m).padStart(2, '0')}m left</span>}
        </div>
      )}

      {controls && (
        <div className="desk-header-actions">
          <div className="desk-controls-wrap">{controls}</div>
        </div>
      )}
    </header>
  );
}
