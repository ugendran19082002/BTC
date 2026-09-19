import type { ChainResponse } from '@/types/desk';
import type { SideChoice } from '@/lib/overview';
import { probabilityLabel, type ScreenConfig } from '@/lib/screen-config';

const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const IST_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

const HORIZONS: { min: number; label: string }[] = [
  { min: 5, label: '5m' }, { min: 15, label: '15m' }, { min: 30, label: '30m' }, { min: 60, label: '1h' },
  { min: 180, label: '3h' }, { min: 360, label: '6h' }, { min: 720, label: '12h' }, { min: 1440, label: '24h' },
];

/**
 * Which configuration this screen is deciding with, in one line, every
 * setting editable where it is shown. Dynamic values (entry, time to expiry,
 * data) are marked so; contract-fixed ones (expiry) are marked so; the rest
 * are the operator's and change what every panel below computes.
 */
export function ContextBar({ data, now, config, onChange, choice, contracts, deskContracts }: {
  data: ChainResponse; now: number; config: ScreenConfig; onChange: (patch: Partial<ScreenConfig>) => void;
  choice: SideChoice; contracts: number; deskContracts: number;
}) {
  const snap = data.snapshot;
  const expiryMs = snap.expiryTs * 1000;
  const leftMs = Math.max(0, expiryMs - (snap.live ? now : snap.ts * 1000));
  const h = Math.floor(leftMs / 3_600_000), m = Math.floor((leftMs % 3_600_000) / 60_000);
  const age = Math.max(0, Math.round((now - snap.ts * 1000) / 1000));
  const sel = <K extends keyof ScreenConfig>(key: K, options: readonly { v: ScreenConfig[K]; label: string }[]) => (
    <select className="ov-select ov-ctx-select" value={String(config[key])} onChange={(e) => {
      const o = options.find((x) => String(x.v) === e.target.value);
      if (o) onChange({ [key]: o.v } as Partial<ScreenConfig>);
    }} aria-label={String(key)}>
      {options.map((o) => <option key={String(o.v)} value={String(o.v)}>{o.label}</option>)}
    </select>
  );
  return (
    <div className="ov-ctx" role="toolbar" aria-label="Decision configuration">
      <Item label="Entry" tag="dynamic" tone="up">
        <b>{snap.live ? IST_HM.format(new Date(now)) : IST_HM.format(new Date(snap.ts * 1000))} IST</b>
        <input className="ov-ctx-input" aria-label="Strategy entry window (IST)" value={config.entryIst} pattern="\d{1,2}:\d{2}"
          title="The strategy's entry window, IST. Entry itself is now; this is what it is judged against." onChange={(e) => onChange({ entryIst: e.target.value })} />
      </Item>
      <Item label="Expiry" tag="contract fixed" tone="accent">
        <b>{IST_DATE.format(new Date(expiryMs))} · {IST_HM.format(new Date(expiryMs))}</b>
      </Item>
      <Item label="Time to expiry" tag="dynamic" tone="up"><b>{leftMs === 0 ? 'settled' : `${h}h ${String(m).padStart(2, '0')}m`}</b></Item>
      <Item label="Prediction">{sel('horizonMin', HORIZONS.map((x) => ({ v: x.min, label: x.label })))}</Item>
      <Item label="Execution"><b>Short premium</b> {sel('execution', [{ v: 'BID', label: 'fill at bid' }, { v: 'DEPTH', label: 'depth-weighted' }, { v: 'MARK', label: 'mark (not executable)' }])}</Item>
      <Item label="Side mode">{sel('sideMode', [{ v: 'AUTO', label: 'AUTO' }, { v: 'CE_ONLY', label: 'CE only' }, { v: 'PE_ONLY', label: 'PE only' }, { v: 'BOTH_ALLOWED', label: 'Both allowed' }])} <small className="ov-muted">→ {choice.side.replace('_', ' ')}</small></Item>
      <Item label="Strictness">{sel('strictness', [{ v: 'STRICT', label: 'STRICT' }, { v: 'BALANCED', label: 'BALANCED' }, { v: 'AGGRESSIVE', label: 'AGGRESSIVE' }])}</Item>
      <Item label="Risk">{sel('riskMode', [{ v: 'CONSERVATIVE', label: 'CONSERVATIVE' }, { v: 'BALANCED', label: 'BALANCED' }, { v: 'AGGRESSIVE', label: 'AGGRESSIVE' }])}</Item>
      <Item label="Expected move">{sel('emMethod', [{ v: 'IV', label: 'IV' }, { v: 'HISTORICAL', label: 'Historical' }, { v: 'HYBRID', label: 'Hybrid' }])}</Item>
      <Item label="Probability">{sel('probabilityMode', [{ v: 'MODEL', label: 'Model' }, { v: 'DELTA', label: 'Delta baseline' }, { v: 'HYBRID', label: 'Hybrid' }])} <small className="ov-muted">{probabilityLabel(config.probabilityMode)} P(OTM)</small></Item>
      <Item label="Strike rule">{sel('strikeRule', [{ v: 'HYBRID', label: 'Hybrid' }, { v: 'OI_WALL', label: 'By OI wall' }, { v: 'EXPECTED_MOVE', label: 'By expected move' }])}</Item>
      <Item label="Fee ×">{sel('feeMultiplier', [{ v: 0.5, label: '0.5' }, { v: 1, label: '1.0' }, { v: 1.5, label: '1.5' }, { v: 2, label: '2.0' }])}</Item>
      <Item label="Fresh ≤">{sel('freshnessSec', [{ v: 5, label: '5 s' }, { v: 15, label: '15 s' }, { v: 30, label: '30 s' }, { v: 60, label: '60 s' }])}</Item>
      <Item label="Size">
        <select className="ov-select ov-ctx-select" aria-label="contracts" value={config.contracts === null ? 'desk' : String(config.contracts)}
          onChange={(e) => onChange({ contracts: e.target.value === 'desk' ? null : Number(e.target.value) })}>
          <option value="desk">desk ({deskContracts})</option>
          {[1, 2, 3, 5, 10, 20, 50].filter((n) => n !== deskContracts).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <small className="ov-muted">{contracts} ct</small>
      </Item>
      <Item label="Model"><b>{data.outlook.model ? data.outlook.model.name : 'desk figures'}</b></Item>
      <Item label="Data" tag={snap.live ? (age <= config.freshnessSec ? 'live' : 'stale') : 'past'} tone={snap.live && age <= config.freshnessSec ? 'up' : 'down'}><b>{snap.live ? `${age}s` : 'snapshot'}</b></Item>
    </div>
  );
}

function Item({ label, tag, tone, children }: { label: string; tag?: string; tone?: 'up' | 'down' | 'accent'; children: React.ReactNode }) {
  return (
    <div className="ov-ctx-item">
      <span className="ov-ctx-label">{label}{tag && <em className={`ov-ctx-tag ov-${tone ?? 'muted'}`}>{tag}</em>}</span>
      <span className="ov-ctx-value">{children}</span>
    </div>
  );
}
