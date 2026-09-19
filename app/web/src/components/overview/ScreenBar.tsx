import { useState, type ReactNode } from 'react';
import type { ChainResponse, ExpiryOption } from '@/types/desk';
import { Tag } from './parts';

const IST_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/**
 * The bar above the screen: who and when (brand, clock, live), the contract
 * on the board and the list to change it, the screen's mode and refresh
 * controls, and the glossary. The screen decides with the desk's fixed
 * configuration (lib/screen-config.ts); nothing here changes it.
 */
export function ScreenBar({ data, now, freshnessSec, expiries, onExpiry, controls, error }: {
  data: ChainResponse; now: number; freshnessSec: number;
  expiries?: readonly ExpiryOption[]; onExpiry?: (expiry: string) => void;
  controls?: ReactNode; error?: string | null;
}) {
  const [help, setHelp] = useState(false);
  const snap = data.snapshot;
  const age = Math.max(0, Math.round((now - snap.ts * 1000) / 1000));
  const away = (h: number) => (h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
  return (
    <div className="ov-settings">
      <header className="ov-screenbar">
        <div className="ov-brand">
          <span className="btc-logo" aria-hidden>₿</span>
          <span><b>BTC Options Desk</b><small>Delta Exchange (India) · Option selling intelligence</small></span>
        </div>
        <div className="ov-screenbar-right">
          {error && <Tag tone="down">{error}</Tag>}
          <span className="ov-clock">{IST_CLOCK.format(new Date(now)).replace(/,/g, '')} IST</span>
          <Tag tone={snap.live ? (age <= freshnessSec ? 'up' : 'warn') : 'muted'}>{snap.live ? `● Live · ${age}s` : 'Past snapshot'}</Tag>
          {expiries && onExpiry && expiries.length > 0 ? (
            <label className="ov-inline-label">Expiry
              <select aria-label="Expiry" className="ov-select" value={snap.expiry} onChange={(e) => onExpiry(e.target.value)}>
                {!expiries.some((e) => e.expiry === snap.expiry) && <option value={snap.expiry}>{snap.expiry}</option>}
                {expiries.map((e) => (
                  <option key={e.expiry} value={e.expiry}>{e.expiry} · {away(e.hoursAway)}{e.isNextEntry ? ' · next entry' : e.isDaily ? ' · daily' : ''}</option>
                ))}
              </select>
            </label>
          ) : <Tag tone="accent">{snap.expiry}</Tag>}
          {controls}
          <button className="ov-chip" onClick={() => setHelp((v) => !v)} aria-pressed={help} title="What the terms on this screen mean">?</button>
        </div>
      </header>

      {help && (
        <dl className="ov-glossary">
          <div><dt>POP / P(OTM)</dt><dd>Probability the option expires worthless — the short keeps the premium.</dd></div>
          <div><dt>PoT</dt><dd>Probability BTC touches the strike before expiry, even if it comes back. Different from expiring beyond it.</dd></div>
          <div><dt>EM</dt><dd>Expected move: spot × IV × √t. "1.2× EM away" means the strike is 1.2 expected moves from spot.</dd></div>
          <div><dt>IV − RV</dt><dd>Implied minus realised volatility. Positive: sellers are paid more than BTC has been delivering.</dd></div>
          <div><dt>Tail loss</dt><dd>The loss if BTC moves two expected moves the wrong way — the loss the desk plans for; a naked short has no bounded worst case.</dd></div>
          <div><dt>R/R</dt><dd>Expected P&amp;L per dollar of tail loss.</dd></div>
          <div><dt>CVD</dt><dd>Cumulative volume delta: buys that lifted the offer minus sells that hit the bid, running.</dd></div>
          <div><dt>OI wall</dt><dd>The strike with the heaviest open interest on that side — where the crowd is positioned.</dd></div>
          <div><dt>Gates</dt><dd>PASS / FAIL checks. Hard gates never soften; soft gates may fail up to the strictness allowance and still show WATCH.</dd></div>
          <div><dt>ENTRY READY</dt><dd>Every gate on the checklist is green. Selling still goes through the ticket, where the server runs every gate again.</dd></div>
        </dl>
      )}
    </div>
  );
}
