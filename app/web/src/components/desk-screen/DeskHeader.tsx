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
  const shown = expiryLabel ? friendlyExpiry(expiryLabel) : null;
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

      {shown && (
        <div className="desk-expiry-pill" title={`Expiry ${expiryLabel}`}>
          <span>Expiry <b className="desk-expiry-date">{shown}</b></span>
          {left !== null && (
            <span className={`desk-expiry-countdown${left < 1 ? ' is-urgent' : left < 3 ? ' is-soon' : ''}`}>
              {h}h {String(m).padStart(2, '0')}m left
            </span>
          )}
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Delta's expiry code read as a date: "011026 17:30 IST" -> "1 Oct, 17:30 IST". Anything else as given. */
export function friendlyExpiry(label: string): string {
  const m = /^(\d{2})(\d{2})(\d{2})(.*)$/.exec(label);
  if (!m) return label;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[1])} ${month},${m[4]}` : label;
}

