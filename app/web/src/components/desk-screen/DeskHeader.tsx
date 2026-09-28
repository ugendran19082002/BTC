import React from 'react';
import { Bell, Moon, Settings, Sun } from 'lucide-react';

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
  onAlerts,
  onSettings,
  controls,
}: {
  expiryLabel?: string;
  hoursToExpiry?: number;
  onAlerts?: () => void;
  onSettings?: () => void;
  controls?: React.ReactNode;
}) {
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark');
  const left = hoursToExpiry !== undefined && Number.isFinite(hoursToExpiry) && hoursToExpiry > 0 ? hoursToExpiry : null;
  const h = left === null ? 0 : Math.floor(left);
  const m = left === null ? 0 : Math.round((left - h) * 60);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
  };

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

      <div className="desk-header-actions">
        {controls && <div className="desk-controls-wrap">{controls}</div>}

        <button type="button" className="desk-btn-tool" onClick={onAlerts} title="Alerts">
          <Bell size={14} />
          <span>Alerts</span>
        </button>

        <button type="button" className="desk-btn-tool" onClick={onSettings} title="Settings">
          <Settings size={14} />
          <span>Settings</span>
        </button>

        <button type="button" className="desk-btn-tool" onClick={toggleTheme} title="Toggle dark / light mode" aria-label="Toggle dark / light mode">
          {theme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
        </button>
      </div>
    </header>
  );
}
