import React from 'react';
import { Bell, Moon, Settings, Sun } from 'lucide-react';
import type { ChartTf } from '@/components/desk/PriceChart';

const TFS: readonly ChartTf[] = ['1m', '5m', '15m', '30m', '1h', '4h'];

export function DeskHeader({
  spot,
  changePct = 0.32,
  tf = '15m',
  onTf,
  expiryLabel = '28 Sept 17:30 IST',
  hoursToExpiry = 20.6,
  onAlerts,
  onSettings,
  controls,
}: {
  spot: number;
  changePct?: number;
  tf: ChartTf;
  onTf: (tf: ChartTf) => void;
  expiryLabel?: string;
  hoursToExpiry?: number;
  onAlerts?: () => void;
  onSettings?: () => void;
  controls?: React.ReactNode;
}) {
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark');
  const h = Math.floor(hoursToExpiry);
  const m = Math.round((hoursToExpiry - h) * 60);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
  };

  return (
    <header className="desk-header">
      <div className="desk-header-left">
        <div className="desk-logo-box">
          <div className="desk-btc-icon">₿</div>
          <div className="desk-title-group">
            <h1>BTC Live Desk</h1>
            <span>Delta Exchange India · Options · Live Analysis</span>
          </div>
        </div>

        <div className="desk-live-badge">
          <span className="desk-live-dot" />
          <span>LIVE</span>
        </div>

        <div className="desk-tf-selector" role="group" aria-label="Timeframe selector">
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              className={`desk-tf-btn ${tf === t ? 'active' : ''}`}
              onClick={() => onTf(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="desk-expiry-pill">
          <span>Expiry: {expiryLabel}</span>
          <span className="desk-expiry-countdown">{h}h {String(m).padStart(2, '0')}m left</span>
        </div>
      </div>

      <div className="desk-header-right">
        {controls && <div className="desk-controls-wrap" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{controls}</div>}
        <div className="desk-spot-chip">
          <span className="desk-spot-lbl">BTC Spot</span>
          <span className="desk-spot-val">
            {spot ? spot.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '84,595.0'}
            <span style={{ fontSize: 11, marginLeft: 6, color: changePct >= 0 ? '#00e676' : '#ff3b57' }}>
              {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
            </span>
          </span>
        </div>

        <button type="button" className="desk-btn-tool" onClick={onAlerts} title="Alerts">
          <Bell size={14} />
          <span>Alerts</span>
        </button>

        <button type="button" className="desk-btn-tool" onClick={onSettings} title="Settings">
          <Settings size={14} />
          <span>Settings</span>
        </button>

        <button type="button" className="desk-btn-tool" onClick={toggleTheme} title="Toggle Dark/Light Mode">
          {theme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
        </button>
      </div>
    </header>
  );
}
