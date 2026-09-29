import { useState } from 'react';
import { LocateFixed, RotateCcw, X } from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import type { HistoryRow, TradeRecord } from '@/lib/smc/readout';
import type { TrendPaperSummary, TrendPaperTrade } from '@/api/desk';

/**
 * Every trade, in one place, off the chart: the SMC plan's trades on this
 * chart, and the trend plan's paper log from the server. A modal rather than a
 * table inside the readout, so the list can be long and readable without
 * covering the candles; a bottom sheet on a phone. Each SMC row can put its
 * trade back in view on the chart.
 *
 * Rows can be hidden -- one at a time, or all at once after a confirm -- and
 * brought back. Hidden, never deleted: the SMC trades are recomputed from the
 * candles, and the paper log is the forward test, which a delete button would
 * make meaningless. Hiding is this browser's view only, and the summary counts
 * every trade, hidden or not, so hiding a loss never flatters the record.
 */

const fmt = (p: number) => Math.round(p).toLocaleString('en-US');
const r1 = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}R`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const tone = (r: number) => (r > 0.05 ? 'up' : r < -0.05 ? 'down' : '');

type Tab = 'smc' | 'trend';

export function TradesDialog({
  open, onOpenChange, history, record, paper, onJump,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** This chart's completed SMC trades, newest first. */
  history: readonly HistoryRow[];
  record: TradeRecord | null;
  /** The trend plan's paper log, when the server has one. */
  paper?: { summary: readonly TrendPaperSummary[]; trades: readonly TrendPaperTrade[] } | null;
  /** Put a trade (its entry time, epoch seconds) in view on the chart. */
  onJump?: (time: number) => void;
}) {
  const [tab, setTab] = useState<Tab>('smc');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title="Trades" description="Information, not signals: each plan's record after fees." className="pc-trades sm:w-[min(980px,94vw)]">
        <div className="pc-tabs" role="tablist" aria-label="Which trades">
          <button type="button" role="tab" aria-selected={tab === 'smc'} className={`pc-tab${tab === 'smc' ? ' on' : ''}`} onClick={() => setTab('smc')}>
            SMC plan · this chart <b>{history.length}</b>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'trend'} className={`pc-tab${tab === 'trend' ? ' on' : ''}`} onClick={() => setTab('trend')}>
            Trend plan · paper log <b>{paper?.trades.length ?? 0}</b>
          </button>
        </div>
        {tab === 'smc' ? <SmcTrades history={history} record={record} onJump={onJump && ((t) => { onJump(t); onOpenChange(false); })} /> : <TrendTrades paper={paper ?? null} />}
      </SheetContent>
    </Sheet>
  );
}

/** Which rows this browser has hidden, per list, and the controls that go with them. */
function useHidden(key: string) {
  const [hidden, setHidden] = usePersisted<string[]>(`trades:hidden:${key}`, []);
  const [showHidden, setShowHidden] = useState(false);
  const set = new Set(hidden);
  return {
    set, showHidden, setShowHidden,
    hide: (id: string) => setHidden([...new Set([...hidden, id])]),
    unhide: (id: string) => setHidden(hidden.filter((x) => x !== id)),
    hideAll: (ids: readonly string[]) => setHidden([...new Set([...hidden, ...ids])]),
    restore: () => { setHidden([]); setShowHidden(false); },
  };
}

/** Clear all (after a confirm), show the hidden rows, restore them all. */
function ListActions({ total, hiddenHere, h }: { total: readonly string[]; hiddenHere: number; h: ReturnType<typeof useHidden> }) {
  const [confirm, setConfirm] = useState(false);
  const visible = total.filter((id) => !h.set.has(id));
  return (
    <div className="pc-list-actions">
      {hiddenHere > 0 && (
        <>
          <span className="pc-hidden-note">{hiddenHere} hidden</span>
          <button type="button" className="pc-act" aria-pressed={h.showHidden} onClick={() => h.setShowHidden(!h.showHidden)}>{h.showHidden ? 'Hide them again' : 'Show hidden'}</button>
          <button type="button" className="pc-act" onClick={h.restore}><RotateCcw size={12} aria-hidden /> Restore all</button>
        </>
      )}
      {visible.length > 0 && (confirm ? (
        <span className="pc-confirm" role="group" aria-label="Confirm clearing the list">
          Hide all {visible.length}?
          <button type="button" className="pc-act danger" onClick={() => { h.hideAll(visible); setConfirm(false); }}>Yes, clear</button>
          <button type="button" className="pc-act" onClick={() => setConfirm(false)}>Cancel</button>
        </span>
      ) : (
        <button type="button" className="pc-act" onClick={() => setConfirm(true)}>Clear all</button>
      ))}
    </div>
  );
}

/** The last cell of a row: hide it, or bring it back when hidden rows are shown. */
function RowToggle({ id, h, label }: { id: string; h: ReturnType<typeof useHidden>; label: string }) {
  return h.set.has(id) ? (
    <button type="button" className="pc-jump" onClick={() => h.unhide(id)} aria-label={`Restore the ${label} trade`} title="Restore"><RotateCcw size={13} aria-hidden /></button>
  ) : (
    <button type="button" className="pc-jump" onClick={() => h.hide(id)} aria-label={`Hide the ${label} trade`} title="Hide from this list (the record still counts it)"><X size={13} aria-hidden /></button>
  );
}

function Stat({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return <div className="pc-stat"><span>{label}</span><b className={cls}>{value}</b></div>;
}

function SmcTrades({ history, record, onJump }: { history: readonly HistoryRow[]; record: TradeRecord | null; onJump?: (time: number) => void }) {
  const h = useHidden('smc');
  if (!history.length) return <p className="pc-empty-note">No finished SMC trade on the candles this chart has loaded yet.</p>;
  const ids = history.map((r) => r.id);
  const hiddenHere = ids.filter((id) => h.set.has(id)).length;
  const rows = history.filter((r) => h.showHidden || !h.set.has(r.id));
  const total = history.reduce((a, r) => a + r.resultR, 0);
  const wins = history.filter((r) => r.resultR > 0).length;
  return (
    <>
      <div className="pc-stats" aria-label="SMC record on this chart">
        <Stat label="Trades" value={String(history.length)} />
        <Stat label="Won" value={pct(wins / history.length)} />
        {record && <Stat label="TP1 hit" value={pct(record.tp1Rate)} />}
        {record && <Stat label="Stopped" value={pct(record.stopRate)} />}
        <Stat label="Average" value={r1(total / history.length)} cls={tone(total / history.length)} />
        <Stat label="Total" value={r1(total)} cls={tone(total)} />
        {record && <Stat label="MFE / MAE" value={`${record.avgMfeR.toFixed(1)} / ${record.avgMaeR.toFixed(1)}R`} />}
      </div>
      <ListActions total={ids} hiddenHere={hiddenHere} h={h} />
      {!rows.length && <p className="pc-empty-note">Every trade here is hidden. The figures above still count them.</p>}
      <div className="pc-trades-wrap">
        <table className="pc-trades-table">
          <thead>
            <tr><th>Time (IST)</th><th>Side</th><th>Entry</th><th>SL</th><th>TP1</th><th>Exit</th><th>Result</th><th>MFE</th><th>MAE</th><th>Min</th><th>What happened</th>{onJump && <th aria-label="Show on chart" />}<th aria-label="Hide" /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={h.set.has(r.id) ? 'is-hidden' : ''}>
                <td>{IST.format(r.time * 1000)}</td>
                <td><span className={`pc-side ${r.dir === 'bull' ? 'long' : 'short'}`}>{r.dir === 'bull' ? 'Long' : 'Short'}</span></td>
                <td>{fmt(r.entry)}</td><td>{fmt(r.stop)}</td><td>{fmt(r.tp1)}</td><td>{fmt(r.exit)}</td>
                <td className={`num ${tone(r.resultR)}`}>{r1(r.resultR)}</td>
                <td>{r.mfeR.toFixed(1)}R</td><td>{r.maeR.toFixed(1)}R</td><td>{r.minutes}</td>
                <td className="path">{r.path}</td>
                {onJump && (
                  <td>
                    <button type="button" className="pc-jump" onClick={() => onJump(r.time)} aria-label={`Show the ${IST.format(r.time * 1000)} trade on the chart`} title="Show on chart">
                      <LocateFixed size={14} aria-hidden />
                    </button>
                  </td>
                )}
                <td><RowToggle id={r.id} h={h} label={IST.format(r.time * 1000)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pc-foot-note">Recomputed from the candles this chart has loaded, before fees; the figures count every trade, hidden or not. Over 32 months the SMC plan lost −0.17R a trade after fees (research/SMC-STUDY.txt).</p>
    </>
  );
}

function TrendTrades({ paper }: { paper: { summary: readonly TrendPaperSummary[]; trades: readonly TrendPaperTrade[] } | null }) {
  const h = useHidden('trend');
  if (!paper) return <p className="pc-empty-note">The paper log has not answered yet.</p>;
  const idOf = (t: TrendPaperTrade) => `${t.tf}:${t.entryTime}`;
  const ids = paper.trades.map(idOf);
  const hiddenHere = ids.filter((id) => h.set.has(id)).length;
  const rows = paper.trades.filter((t) => h.showHidden || !h.set.has(idOf(t)));
  return (
    <>
      <div className="pc-stats" aria-label="Trend plan paper record">
        {paper.summary.map((s) => (
          <div key={s.tf} className="pc-stat wide">
            <span>{s.tf} · live forward test</span>
            <b className={tone(s.netR)}>{s.closed} closed{s.closed ? ` · ${r1(s.netR)} · won ${pct(s.wins / s.closed)}` : ''}{s.open ? ` · ${s.open} open` : ''}</b>
            {s.replayed > 0 && <small>{s.replayed} replayed, not counted</small>}
          </div>
        ))}
      </div>
      {paper.trades.length > 0 && <ListActions total={ids} hiddenHere={hiddenHere} h={h} />}
      {!paper.trades.length ? (
        <p className="pc-empty-note">No trend trade yet since the log began.</p>
      ) : !rows.length ? (
        <p className="pc-empty-note">Every trade here is hidden. The log and its figures keep them all.</p>
      ) : (
        <div className="pc-trades-wrap">
          <table className="pc-trades-table">
            <thead>
              <tr><th>TF</th><th>Signal (IST)</th><th>Side</th><th>Entry</th><th>Stop</th><th>Stop now</th><th>Exit</th><th>Result</th><th>Status</th><th>Filters</th><th aria-label="Hide" /></tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={idOf(t)} className={h.set.has(idOf(t)) ? 'is-hidden' : ''}>
                  <td>{t.tf}</td>
                  <td>{IST.format(t.entryTime * 1000)}</td>
                  <td><span className={`pc-side ${t.dir === 1 ? 'long' : 'short'}`}>{t.dir === 1 ? 'Long' : 'Short'}</span></td>
                  <td>{fmt(t.entry)}</td><td>{fmt(t.stop0)}</td><td>{t.exit === null ? fmt(t.stop) : '—'}</td>
                  <td>{t.exit === null ? '—' : fmt(t.exit)}</td>
                  <td className={`num ${t.rNet === null ? '' : tone(t.rNet)}`}>{t.rNet === null ? 'open' : r1(t.rNet)}</td>
                  <td><span className={`pc-badge ${t.live ? 'live' : ''}`} title={t.live ? 'Recorded within 15 minutes of its signal: part of the forward test' : 'Written later (a restart or a replay): not counted'}>{t.live ? 'live' : 'replayed'}</span></td>
                  <td className="path">{[t.volBurst ? 'volume burst' : null, t.session ? 'London / NY' : null].filter(Boolean).join(' · ') || '—'}</td>
                  <td><RowToggle id={idOf(t)} h={h} label={`${t.tf} ${IST.format(t.entryTime * 1000)}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="pc-foot-note">Paper only: nothing is ordered. Results after taker fees (0.05% a side). Only live trades count toward the forward test; review on 31 Oct 2026. Hiding a row changes this list only -- the log keeps every trade.</p>
    </>
  );
}
