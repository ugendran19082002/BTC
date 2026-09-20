import { useState, type ReactNode } from 'react';
import type { ChainResponse, ExpiryOption } from '@/types/desk';
import { entryTodayMs } from '@/lib/screen-config';
import { contractValidity, dataFreshness } from '@/lib/overview';
import { Tag } from './parts';

const IST_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const IST_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
const IST_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
const hm = (ms: number) => `${Math.floor(ms / 3_600_000)}h ${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}m`;

/**
 * The bar above the screen: who and when (brand, clock, live), the contract
 * on the board and the list to change it, its day (entry is now, the window
 * is the strategy's, expiry is the contract's, and how long is left),
 * whether the contract can still be traded (LIVE / EXPIRING / EXPIRED), how
 * old each thing on the screen is (market · chain · OI · model), the
 * screen's mode and refresh controls, and the glossary. The screen decides with the desk's fixed
 * configuration (lib/screen-config.ts); nothing here changes it.
 */
export function ScreenBar({ data, now, freshnessSec, entryIst, expiries, onExpiry, controls, error }: {
  data: ChainResponse; now: number; freshnessSec: number; entryIst: string;
  expiries?: readonly ExpiryOption[]; onExpiry?: (expiry: string) => void;
  controls?: ReactNode; error?: string | null;
}) {
  const [help, setHelp] = useState(false);
  const snap = data.snapshot;
  const validity = contractValidity(snap, now);
  const ages = dataFreshness(data.freshness, now, { market: freshnessSec * 1000, chain: freshnessSec * 1000, oi: 15 * 60_000, model: 7 * 86_400_000 });
  const stale = ages.filter((a) => a.stale);
  // An expiry as a person says it: the day, when it settles, how far away, and what it is to the desk.
  const away = (h: number) => (h <= 0 ? 'settled' : h < 1 ? `${Math.round(h * 60)}m left` : h < 48 ? `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m left` : `${Math.round(h / 24)}d away`);
  const expiryLabel = (e: { expiry: string; expiryTs: number; hoursAway: number; isDaily: boolean; isNextEntry: boolean; isDefault?: boolean }) =>
    `${IST_DAY.format(new Date(e.expiryTs * 1000))} · 17:30 IST · ${away(e.hoursAway)}${e.isNextEntry ? ' · next entry ★' : e.isDaily ? ' · daily' : e.hoursAway >= 24 * 6 ? ' · weekly / monthly' : ''}`;
  const entryMs = snap.live ? now : snap.ts * 1000;
  const windowMs = entryTodayMs(entryIst, entryMs);
  const since = windowMs === null ? null : entryMs - windowMs;
  const windowText = since === null ? '' : since >= 0 && since <= 30 * 60_000 ? ' · in window' : since > 0 ? ` · ${hm(since)} since` : ` · in ${Math.ceil(-since / 60_000)}m`;
  const leftMs = Math.max(0, snap.expiryTs * 1000 - entryMs);
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
          <Tag tone={validity.state === 'LIVE' ? 'up' : validity.state === 'EXPIRING' ? 'warn' : 'down'}>
            <span title={validity.text}>{validity.state === 'LIVE' ? '● ' : ''}{validity.state}</span>
          </Tag>
          <span className={`ov-ages${stale.length ? ' ov-ages-stale' : ''}`} title={snap.live ? `How old each reading is. Stale past ${freshnessSec}s for the market and the chain, 15m for the OI record, 7d for the model.` : 'A past snapshot: ages mean nothing'}>
            {snap.live ? ages.map((a) => (
              <span key={a.key} className={a.stale ? 'ov-warn' : undefined} title={a.hint}>{a.label} <b>{a.text}</b></span>
            )) : <span>past snapshot</span>}
          </span>
          {expiries && onExpiry && expiries.length > 0 ? (
            <label className="ov-inline-label">Expiry
              <select aria-label="Expiry" className="ov-select" value={snap.expiry} onChange={(e) => onExpiry(e.target.value)}>
                {!expiries.some((e) => e.expiry === snap.expiry) && <option value={snap.expiry}>{IST_DAY.format(new Date(snap.expiryTs * 1000))} · 17:30 IST</option>}
                {expiries.map((e) => (
                  <option key={e.expiry} value={e.expiry}>{expiryLabel(e)}</option>
                ))}
              </select>
            </label>
          ) : <Tag tone="accent">{snap.expiry}</Tag>}
          <span className="ov-day" title="Entry is now; the window is the strategy's own entry time; expiry is the contract's settlement">
            entry {IST_HM.format(new Date(entryMs))} · window {entryIst}{windowText} → {IST_DATE.format(new Date(snap.expiryTs * 1000))} {IST_HM.format(new Date(snap.expiryTs * 1000))} · <b>{leftMs === 0 ? 'settled' : `${hm(leftMs)} left`}</b>
          </span>
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
