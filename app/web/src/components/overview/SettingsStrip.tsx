import { useState, type ReactNode } from 'react';
import type { ChainResponse } from '@/types/desk';
import type { SideChoice } from '@/lib/overview';
import { DEFAULT_CONFIG, probabilityLabel, thresholds, type ScreenConfig } from '@/lib/screen-config';
import { Tag } from './parts';

const IST_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const IST_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

const HORIZONS: { min: number; label: string }[] = [
  { min: 5, label: '5m' }, { min: 15, label: '15m' }, { min: 30, label: '30m' }, { min: 60, label: '1h' },
  { min: 180, label: '3h' }, { min: 360, label: '6h' }, { min: 720, label: '12h' }, { min: 1440, label: '24h' },
];

/** One-click presets: strictness and risk together, the way a person thinks of them. */
const PRESETS: { name: string; patch: Partial<ScreenConfig>; hint: string }[] = [
  { name: 'Conservative', patch: { strictness: 'STRICT', riskMode: 'CONSERVATIVE' }, hint: 'Every gate must pass; touch ≤ 25%, ≥ 1.25 expected moves out, a quarter of the size cap' },
  { name: 'Balanced', patch: { strictness: 'BALANCED', riskMode: 'BALANCED' }, hint: 'Two soft failures allowed; touch ≤ 35%, ≥ 1 expected move out, half the size cap' },
  { name: 'Aggressive', patch: { strictness: 'AGGRESSIVE', riskMode: 'AGGRESSIVE' }, hint: 'Four soft failures allowed; touch ≤ 45%, ≥ 0.75 expected moves out, the full size cap. Hard safety limits still hold' },
];

/**
 * The strip above the chart: who and when (brand, clock, live), the screen's
 * mode and refresh controls, and every setting the screen decides with --
 * grouped, each with what it does on hover, with presets and a reset.
 *
 * Dynamic values (entry, time to expiry, data age) are marked so; the expiry
 * is marked contract-fixed and cannot be typed. A line under the rules says
 * in plain numbers what the current risk mode and strictness allow, so a
 * change is never a mystery.
 */
export function SettingsStrip({ data, now, config, stored, onChange, onReset, choice, contracts, deskContracts, controls, error }: {
  data: ChainResponse; now: number; config: ScreenConfig; stored: Partial<ScreenConfig>;
  onChange: (patch: Partial<ScreenConfig>) => void; onReset: () => void;
  choice: SideChoice; contracts: number; deskContracts: number; controls?: ReactNode; error?: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [help, setHelp] = useState(false);
  const snap = data.snapshot;
  const expiryMs = snap.expiryTs * 1000;
  const leftMs = Math.max(0, expiryMs - (snap.live ? now : snap.ts * 1000));
  const h = Math.floor(leftMs / 3_600_000), m = Math.floor((leftMs % 3_600_000) / 60_000);
  const age = Math.max(0, Math.round((now - snap.ts * 1000) / 1000));
  const t = thresholds(config);
  const changed = Object.keys(stored).filter((k) => stored[k as keyof ScreenConfig] !== undefined && stored[k as keyof ScreenConfig] !== DEFAULT_CONFIG[k as keyof ScreenConfig]).length;
  const preset = PRESETS.find((p) => p.patch.strictness === config.strictness && p.patch.riskMode === config.riskMode)?.name ?? 'Custom';

  const sel = <K extends keyof ScreenConfig>(key: K, options: readonly { v: ScreenConfig[K]; label: string }[], title: string) => (
    <select className="ov-select ov-ctx-select" value={String(config[key])} title={title} aria-label={String(key)} onChange={(e) => {
      const o = options.find((x) => String(x.v) === e.target.value);
      if (o) onChange({ [key]: o.v } as Partial<ScreenConfig>);
    }}>
      {options.map((o) => <option key={String(o.v)} value={String(o.v)}>{o.label}</option>)}
    </select>
  );

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
          <Tag tone={snap.live ? (age <= config.freshnessSec ? 'up' : 'warn') : 'muted'}>{snap.live ? `● Live · ${age}s` : 'Past snapshot'}</Tag>
          {controls}
          <span className="ov-presets" role="group" aria-label="Presets">
            {PRESETS.map((p) => (
              <button key={p.name} className={`ov-chip${preset === p.name ? ' on' : ''}`} title={p.hint} onClick={() => onChange(p.patch)}>{p.name}</button>
            ))}
          </span>
          <button className="ov-chip" onClick={onReset} disabled={changed === 0} title="Back to the desk's defaults">Reset{changed ? ` (${changed})` : ''}</button>
          <button className="ov-chip" onClick={() => setHelp((v) => !v)} aria-pressed={help} title="What the terms on this screen mean">?</button>
          <button className="ov-chip" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Show or hide the settings">{open ? 'Settings ▴' : 'Settings ▾'}</button>
        </div>
      </header>

      {open && (
        <div className="ov-ctx" role="toolbar" aria-label="Decision configuration">
          <Group name="Time">
            <Item label="Entry" tag="dynamic" tone="up" title="Entry is now: the moment an order from this screen would fill. The window is the strategy's own entry time, which the checklist judges against.">
              <b>{snap.live ? IST_HM.format(new Date(now)) : IST_HM.format(new Date(snap.ts * 1000))}</b>
              <label className="ov-inline-label">window <input type="time" className="ov-ctx-input" aria-label="Strategy entry window (IST)" value={config.entryIst} onChange={(e) => e.target.value && onChange({ entryIst: e.target.value })} /></label>
            </Item>
            <Item label="Expiry" tag="contract fixed" tone="accent" title="From the selected contract. Never typed in; change it with the expiry selector on the chain.">
              <b>{IST_DATE.format(new Date(expiryMs))} · {IST_HM.format(new Date(expiryMs))}</b>
            </Item>
            <Item label="Time to expiry" tag="dynamic" tone="up"><b>{leftMs === 0 ? 'settled' : `${h}h ${String(m).padStart(2, '0')}m`}</b></Item>
          </Group>

          <Group name="Model">
            <Item label="Horizon" title="The horizon the model view, the expected move and the odds are read at. The contract's expiry does not change with it.">
              {sel('horizonMin', HORIZONS.map((x) => ({ v: x.min, label: x.label })), 'Prediction horizon')}
            </Item>
            <Item label="Probability" title="Where P(OTM) comes from. Model: the measured record where there is one, the option model otherwise. Delta: 1 − |delta|. Hybrid: their mean. The label on every probability follows this.">
              {sel('probabilityMode', [{ v: 'MODEL', label: 'Model' }, { v: 'DELTA', label: 'Delta baseline' }, { v: 'HYBRID', label: 'Hybrid' }], 'Probability method')}
              <small className="ov-muted">{probabilityLabel(config.probabilityMode)} P(OTM)</small>
            </Item>
            <Item label="Expected move" title="IV: spot × IV × √t. Historical: the measured 68% band for the horizon. Hybrid: their mean. Distances in expected moves follow it.">
              {sel('emMethod', [{ v: 'IV', label: 'IV' }, { v: 'HISTORICAL', label: 'Historical' }, { v: 'HYBRID', label: 'Hybrid' }], 'Expected-move method')}
            </Item>
            <Item label="Fresh ≤" title="Chain data older than this blocks entry.">
              {sel('freshnessSec', [{ v: 5, label: '5 s' }, { v: 15, label: '15 s' }, { v: 30, label: '30 s' }, { v: 60, label: '60 s' }], 'Data freshness limit')}
            </Item>
            <Item label="Model" title="The measured model answering, and when it was measured; 'desk figures' when the analytics service is not answering.">
              <b>{data.outlook.model ? `${data.outlook.model.name}${data.outlook.model.measuredAt ? ` · ${data.outlook.model.measuredAt.slice(0, 10)}` : ''}` : 'desk figures'}</b>
            </Item>
          </Group>

          <Group name="Rules">
            <Item label="Side mode" title="AUTO picks the side from the regime, the horizon consensus and each side's gates. CE only / PE only disable the other side. Both allowed lets a range day sell both when each passes on its own.">
              {sel('sideMode', [{ v: 'AUTO', label: 'AUTO' }, { v: 'CE_ONLY', label: 'CE only' }, { v: 'PE_ONLY', label: 'PE only' }, { v: 'BOTH_ALLOWED', label: 'Both allowed' }], 'Side mode')}
              <Tag tone={choice.side === 'NO_TRADE' ? 'down' : choice.side === 'BOTH' ? 'up' : 'accent'}>→ {choice.side.replace('_', ' ')}</Tag>
            </Item>
            <Item label="Strictness" title="How many soft gates may fail and still show WATCH. Hard gates (direction, touch odds, distance, tail, margin) never soften.">
              {sel('strictness', [{ v: 'STRICT', label: 'STRICT' }, { v: 'BALANCED', label: 'BALANCED' }, { v: 'AGGRESSIVE', label: 'AGGRESSIVE' }], 'Strictness')}
            </Item>
            <Item label="Risk" title="Sets the numbers: touch limit, minimum distance in expected moves, slippage limit, tail-loss limit and size cap. The desk's own caps are never exceeded.">
              {sel('riskMode', [{ v: 'CONSERVATIVE', label: 'CONSERVATIVE' }, { v: 'BALANCED', label: 'BALANCED' }, { v: 'AGGRESSIVE', label: 'AGGRESSIVE' }], 'Risk mode')}
            </Item>
            <Item label="Strike rule" title="How candidates are ranked: the desk's hybrid score, by distance from the OI wall, or by distance in expected moves.">
              {sel('strikeRule', [{ v: 'HYBRID', label: 'Hybrid' }, { v: 'OI_WALL', label: 'By OI wall' }, { v: 'EXPECTED_MOVE', label: 'By expected move' }], 'Strike rule')}
            </Item>
          </Group>

          <Group name="Pricing">
            <Item label="Execution" title="The price a short is judged at. Bid: what a seller receives. Depth-weighted: a tick under the bid when the bid is thinner than the size. Mark: not executable, for comparison only.">
              {sel('execution', [{ v: 'BID', label: 'Bid' }, { v: 'DEPTH', label: 'Depth-weighted' }, { v: 'MARK', label: 'Mark (not executable)' }], 'Execution price')}
            </Item>
            <Item label="Fee ×" title="A multiplier on Delta's published taker fee, for stress: net premium and breakeven follow it.">
              {sel('feeMultiplier', [{ v: 0.5, label: '0.5' }, { v: 1, label: '1.0' }, { v: 1.5, label: '1.5' }, { v: 2, label: '2.0' }], 'Fee multiplier')}
            </Item>
            <Item label="Size" title="Contracts per order (0.001 BTC each). 'desk' follows the desk's lots setting. Premium, margin and tail loss scale with it.">
              <select className="ov-select ov-ctx-select" aria-label="contracts" value={config.contracts === null ? 'desk' : String(config.contracts)}
                onChange={(e) => onChange({ contracts: e.target.value === 'desk' ? null : Number(e.target.value) })}>
                <option value="desk">desk ({deskContracts})</option>
                {[1, 2, 3, 5, 10, 20, 50].filter((n) => n !== deskContracts).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <small className="ov-muted">{contracts} ct · {(contracts * 0.001).toFixed(3)} BTC</small>
            </Item>
          </Group>

          <p className="ov-limits">
            <b>{preset}</b> allows: touch ≤ {(t.maxPot * 100).toFixed(0)}% · distance ≥ {t.minEmDistance}× EM · slippage ≤ {(t.maxSlippage * 100).toFixed(0)}% of premium ·
            tail ≤ {(t.tailLimitFactor * 100).toFixed(0)}% of the daily loss limit · size ≤ {(t.sizeFactor * 100).toFixed(0)}% of the short cap · {t.softFailsAllowed} soft failure{t.softFailsAllowed === 1 ? '' : 's'} still WATCH
          </p>
        </div>
      )}

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

function Group({ name, children }: { name: string; children: ReactNode }) {
  return <div className="ov-ctx-group"><span className="ov-ctx-group-name">{name}</span>{children}</div>;
}

function Item({ label, tag, tone, title, children }: { label: string; tag?: string; tone?: 'up' | 'down' | 'accent'; title?: string; children: ReactNode }) {
  return (
    <div className="ov-ctx-item" title={title}>
      <span className="ov-ctx-label">{label}{tag && <em className={`ov-ctx-tag ov-${tone ?? 'muted'}`}>{tag}</em>}{title && <i className="ov-info" aria-hidden>i</i>}</span>
      <span className="ov-ctx-value">{children}</span>
    </div>
  );
}
