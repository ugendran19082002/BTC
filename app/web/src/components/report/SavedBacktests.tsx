import { useCallback, useEffect, useState } from 'react';
import { deleteBacktestSave, deletePortfolio, getBacktestPortfolio, getBacktestSaves, saveBacktest, savePortfolio, type PortfolioCap, type PortfolioLimit } from '@/api/backtest-saves';
import { pct } from '@/lib/format';
import { dayLabel, moneyText, timeIst } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { BacktestPortfolioResult, BacktestSave, BacktestSaves, BtRow, SavedQuery } from '@/types/signal-backtest';
import { Empty, Loading, Panel, Stat, Stats } from '@/components/mobile/parts';
import { Updating, useAnswer } from '@/components/report/Updating';
import { Entry, Ledger, Table, count, each, netClass, rate } from '@/components/report/backtest-parts';

/**
 * Backtests kept by name, and run together (owner, 13 Oct 2026: "save a backtest's settings and run a saved one;
 * several saved ones as a portfolio, with the total of them all").
 *
 * A saved backtest is the settings on the screen -- never a range of days or a result -- so tapping one puts its
 * settings back and the result below is worked for whatever days are chosen. Ticking two or more and running them
 * together works each on its own, as it is alone, and adds them up; the set can be kept under a name as a
 * portfolio and run again in one tap.
 *
 * Both can be edited: a saved backtest's settings (put on the screen, changed there) and its name; a portfolio's
 * members (ticked in the list) and its name. Nothing changes until Save changes.
 */

/** A query as it is compared: every setting named, lists in one order -- the screen leaves out what is off, the desk sends it. */
function shapeOf(q: SavedQuery): string {
  const p = q.params;
  return JSON.stringify({
    rule: p.rule, value: p.value, lots: p.lots, targetPct: p.targetPct, stopPct: p.stopPct, window: p.window,
    hours: p.window === 'custom' ? [p.hoursFrom ?? '', p.hoursTo ?? ''] : null,
    deskMax: p.deskMax ?? 0, cePct: p.cePct ?? 100, pePct: p.pePct ?? 100,
    range: [p.slMin ?? 0, p.slMax ?? 0, p.tgtMin ?? 0, p.tgtMax ?? 0],
    steps: (p.targetSteps ?? []).map((s) => [s.at, Math.round(s.pct * 10_000)]), vol: p.vol ?? 'off', minPremium: p.minPremium ?? 10,
    tfs: [...q.tfs].sort(), methods: [...q.methods].sort(), strategy: q.strategy,
  });
}

const field = 'h-11 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] px-3 text-[16px] text-foreground';
const solid = 'h-11 shrink-0 rounded-lg border-0 bg-[var(--chosen)] px-3 font-[inherit] text-[14px] font-semibold text-[var(--chosen-ink)] disabled:opacity-40';
const quiet = 'h-11 shrink-0 rounded-lg border border-solid border-border bg-transparent px-3 font-[inherit] text-[14px] text-foreground disabled:opacity-40';
const link = 'm-0 min-h-[36px] appearance-none border-0 bg-transparent p-0 font-[inherit] text-[13px] font-medium text-[var(--accent)] disabled:opacity-40';

/** The saved backtests run together: the total, each one, each expiry day, and the margin held across all of them. */
function PortfolioResult({ title, r, wide }: { title: string; r: BacktestPortfolioResult; wide: boolean }) {
  const t = r.total;
  const members: BtRow[] = r.members.map((m) => ({ ...m.total, key: m.id, name: m.name }));
  const days: BtRow[] = [...r.days].reverse().map((d) => ({
    key: d.day, name: `${dayLabel(d.day)}${d.live ? ' · so far' : ''}`, n: d.n, wins: d.wins, losses: d.n - d.wins, net: d.net, won: 0, lost: 0, perpPts: 0, charges: d.charges, exits: {},
  }));
  const failed = r.members.filter((m) => m.problem);
  return (
    <Panel title={`Run together · ${title}`}>
      <p className="m-0 text-[13px] text-muted-foreground">
        {dayLabel(r.from)} → {dayLabel(r.to)} · {r.members.length} saved backtests,{' '}
        {r.shared
          ? <>traded as <b className="font-medium text-foreground">one account</b>: at most {r.shared.max} open together (CE {r.shared.ce} · PE {r.shared.pe}), the longer time frame first, as the desk takes them.</>
          : 'each worked as it is alone and added up.'}
      </p>
      {r.shared && r.shared.turnedAway > 0 && (
        <p className="m-0 mt-0.5 text-[12.5px] text-muted-foreground">{count(r.shared.turnedAway)} signals found the account, or their side of it, full and were not traded.</p>
      )}
      {failed.map((m) => <p key={m.id} role="alert" className="m-0 mt-1 text-[12.5px] text-[var(--warn)]"><b className="font-semibold">{m.name}</b> is left out: {m.problem}</p>)}
      {t.n === 0 ? <div className="mt-2"><Empty>None of them traded in this range.</Empty></div> : (
        <>
          <div className={cn('mt-1 text-[26px] font-semibold tabular-nums', netClass(t.net))}>
            {moneyText(t.net)} <span className="text-[14px] font-medium text-muted-foreground">{each(t)} a trade</span>
          </div>
          <div className="mt-2">
            <Ledger>
              <Entry label="Before charges" tone={t.net + t.charges > 0 ? 'up' : t.net + t.charges < 0 ? 'down' : undefined}>{moneyText(t.net + t.charges)}</Entry>
              <Entry label="Charges" tone="down">{moneyText(-t.charges)}</Entry>
              <Entry label="After charges" tone={t.net > 0 ? 'up' : t.net < 0 ? 'down' : undefined}>{moneyText(t.net)}</Entry>
            </Ledger>
          </div>
          <div className="mt-2">
            <Stats cols={3}>
              <Stat label="Trades">{count(t.n)}</Stat>
              <Stat label="Won">{pct(rate(t), 0)}</Stat>
              <Stat label="Profit factor">{t.lost > 0 ? (t.won / t.lost).toFixed(2) : '—'}</Stat>
            </Stats>
          </div>
          {(() => {
            // A day on average, as the single backtest says it: over the days that traded, and the days in profit and in loss each on their own.
            const traded = r.days.filter((d) => d.n > 0);
            if (traded.length === 0) return null;
            const up = traded.filter((d) => d.net > 0), down = traded.filter((d) => d.net < 0);
            const mean = (xs: typeof traded) => xs.reduce((a, d) => a + d.net, 0) / xs.length;
            const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
            return (
              <div className="mt-2">
                <Ledger>
                  <Entry label={`A day, on average · ${days(traded.length)}`} tone={t.net > 0 ? 'up' : t.net < 0 ? 'down' : undefined}>{moneyText(t.net / traded.length)}</Entry>
                  <Entry label={`A day in profit · ${days(up.length)}`} tone="up">{up.length ? moneyText(mean(up)) : '—'}</Entry>
                  <Entry label={`A day in loss · ${days(down.length)}`} tone="down">{down.length ? moneyText(mean(down)) : '—'}</Entry>
                </Ledger>
              </div>
            );
          })()}
          {r.margin.peakUsd > 0 && (
            <>
              <div className="mt-2">
                <Ledger>
                  <Entry label="Margin at most, together">{moneyText(r.margin.peakUsd).replace('+', '')}</Entry>
                  <Entry label="On that margin" tone={t.net > 0 ? 'up' : t.net < 0 ? 'down' : undefined}>{`${t.net >= 0 ? '+' : '−'}${Math.abs((100 * t.net) / r.margin.peakUsd).toFixed(1)}%`}</Entry>
                  <Entry label="Each one's most, added">{moneyText(r.margin.sumOfPeaksUsd).replace('+', '')}</Entry>
                </Ledger>
              </div>
              <p className="m-0 mt-1 px-1 text-[12px] leading-snug text-muted-foreground">
                Their trades laid on one clock: the most held at once was {r.margin.peakOpen} trade{r.margin.peakOpen === 1 ? '' : 's'}
                {r.margin.peakAt !== null ? ` at ${timeIst(r.margin.peakAt)}` : ''}{r.margin.peakDay ? ` on the ${dayLabel(r.margin.peakDay)} expiry` : ''}
                {r.shared ? <> -- never more than the account&apos;s {r.shared.max}</> : ''} -- what running them side by side on one account would have needed, by the desk&apos;s 200x estimate.
                It is under the sum of each one&apos;s own most where their busiest moments differ.
                {!r.shared && r.margin.peakOpen > 0 && ' Each kept its own limit here, so more may be open together than one account would hold: choose One account to hold them to one limit.'}
              </p>
            </>
          )}
          <div className={cn('mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', wide && 'lg:grid-cols-2')}>
            <section aria-label="Each saved backtest">
              <h3 className="m-0 mb-1 text-[12.5px] font-semibold text-muted-foreground">Each one</h3>
              <Table caption="Run together: each saved backtest" first="Saved backtest" rows={members} />
            </section>
            <section aria-label="Each expiry day, together">
              <h3 className="m-0 mb-1 text-[12.5px] font-semibold text-muted-foreground">By expiry day, together</h3>
              <Table caption="Run together: by expiry day" first="Expiry day" rows={days} />
            </section>
          </div>
          <p className="m-0 mt-2 text-[12px] leading-snug text-muted-foreground">
            {r.shared
              ? 'They share the account’s places: a signal is taken while there is room, the longer time frame first. A signal two of them both take is traded twice, once by each, where there is room for both.'
              : 'One does not take a place from another: each has its own limits, as set in it. A signal two of them both take is traded twice, once by each.'}
          </p>
        </>
      )}
    </Panel>
  );
}

/** Which saved backtests are run together, and what the run is called: a portfolio's name, or theirs. */
export type TogetherRun = { ids: string[]; title: string };

/**
 * The run together, where the results are shown: asked with the days on the screen, and again when they change.
 * Each one is a whole backtest, so the first run of a set takes a moment.
 */
export function PortfolioRun({ run, range, limit = 'shared', cap = null, wide = false, onClose }: {
  run: TogetherRun; range: { from: string; to: string }; limit?: PortfolioLimit;
  /** One account's limit as the screen shows it; null, the desk's own rule (the largest among the saved backtests). */
  cap?: PortfolioCap | null;
  wide?: boolean; onClose: () => void;
}) {
  const asked = limit === 'shared' ? cap : null;
  const result = useAnswer(`${run.ids.join(',')}|${range.from}|${range.to}|${limit}|${asked ? `${asked.max}/${asked.ce}/${asked.pe}` : ''}`, () => getBacktestPortfolio(run.ids, range, limit, asked), 300_000);
  if (result.error && !result.data) {
    return (
      <Panel title={`Run together · ${run.title}`}>
        <p role="alert" className="m-0 text-[13px] text-[var(--down)]">They could not be run together: {result.error.message}</p>
        <button type="button" className={cn(link, 'mt-1')} onClick={onClose}>Close</button>
      </Panel>
    );
  }
  if (!result.data) {
    return <Panel title={`Run together · ${run.title}`}><Loading error={null} what="the run together (each one is a whole backtest: a moment the first time)" /></Panel>;
  }
  return (
    <Updating busy={result.stale} what="the run together">
      <PortfolioResult title={run.title} r={result.data} wide={wide} />
      <button type="button" className={cn(link, 'justify-self-start')} onClick={onClose}>Close the run together</button>
    </Updating>
  );
}

export function SavedBacktests({ mode = 'single', current, wordsOf, onLoad, run, onRun, onSaves }: {
  /**
   * Which of the screen's two sections this is in (owner, 13 Oct 2026: "the portfolio section or the backtest
   * section -- only one open at a time"). `single`: the saved backtests as a list to keep, put back on the screen,
   * edit and delete. `portfolio`: the portfolios to run, edit and delete, and the saved backtests as ticks to run
   * together or keep as a new one.
   */
  mode?: 'single' | 'portfolio';
  /** The settings on the screen now. */
  current: SavedQuery;
  /** A query in one line of words, as the screen's own settings line says it. */
  wordsOf: (q: SavedQuery) => string;
  /** Put a saved backtest's settings on the screen. */
  onLoad: (q: SavedQuery) => void;
  /** The run together on the screen, if any, and how one is started or closed: its results are the screen's to place (`PortfolioRun`). */
  run: TogetherRun | null;
  onRun: (run: TogetherRun | null) => void;
  /** Told the saved backtests whenever they are read: the screen works one account's default limit out from them. */
  onSaves?: (saves: BacktestSave[]) => void;
}) {
  const [list, setList] = useState<BacktestSaves | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [said, setSaid] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [portfolioName, setPortfolioName] = useState('');
  // The saved one whose settings were last put on the screen: changed since, it can be updated in place.
  const [fromId, setFromId] = useState<string | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [asking, setAsking] = useState<string | null>(null);
  /*
   * What is being edited, and its name as typed (owner, 13 Oct 2026: "edit a saved backtest, and edit a
   * portfolio"). A saved backtest: its settings are put on the screen to be changed there, and its name here. A
   * portfolio: its members are ticked in the list to be changed there, and its name here. Nothing is kept until
   * Save changes; Cancel leaves it as it was.
   */
  const [editing, setEditing] = useState<{ kind: 'save' | 'portfolio'; id: string } | null>(null);
  const [editName, setEditName] = useState('');
  const setRun = onRun;

  const refresh = useCallback(() => getBacktestSaves().then((x) => { setList(x); setFailed(null); return x; }, (e: Error) => { setFailed(e.message); return null; }), []);
  useEffect(() => { void refresh(); }, [refresh]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (list) onSaves?.(list.saves); }, [list]);

  const saves = list?.saves ?? [];
  const portfolios = list?.portfolios ?? [];
  const shape = shapeOf(current);
  const shown = saves.find((s) => shapeOf(s.query) === shape) ?? null;
  const from = saves.find((s) => s.id === fromId) ?? null;
  const nameOf = (id: string) => saves.find((s) => s.id === id)?.name ?? 'a deleted one';
  const picked = ticked.filter((id) => saves.some((s) => s.id === id));

  const act = async (what: () => Promise<string>) => {
    setBusy(true); setSaid(null);
    try { const text = await what(); await refresh(); setSaid({ tone: 'ok', text }); }
    catch (e) { setSaid({ tone: 'bad', text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const keep = (id?: string) => act(async () => {
    const r = await saveBacktest({ ...(id ? { id } : {}), name: id ? from!.name : name, query: current });
    setFromId(r.save.id); setName('');
    return id ? `Updated "${r.save.name}" to the settings on the screen.` : `Saved as "${r.save.name}".`;
  });
  const remove = (s: BacktestSave) => act(async () => {
    const r = await deleteBacktestSave(s.id);
    setTicked((t) => t.filter((x) => x !== s.id)); setAsking(null);
    if (editing?.kind === 'save' && editing.id === s.id) setEditing(null);
    if (run?.ids.includes(s.id)) setRun(null);
    return `Deleted "${s.name}".${r.portfoliosDeleted.length ? ` The portfolio${r.portfoliosDeleted.length === 1 ? '' : 's'} ${r.portfoliosDeleted.map((x) => `"${x}"`).join(', ')} had fewer than two left and went with it.` : ''}`;
  });
  const editedSave = editing?.kind === 'save' ? saves.find((s) => s.id === editing.id) ?? null : null;
  const editedPortfolio = editing?.kind === 'portfolio' ? portfolios.find((p) => p.id === editing.id) ?? null : null;
  const editSave = (s: BacktestSave) => { onLoad(s.query); setFromId(s.id); setEditing({ kind: 'save', id: s.id }); setEditName(s.name); setSaid(null); setAsking(null); };
  const editPortfolio = (p: { id: string; name: string; saveIds: string[] }) => { setTicked(p.saveIds); setEditing({ kind: 'portfolio', id: p.id }); setEditName(p.name); setSaid(null); };
  const saveEdit = () => act(async () => {
    if (editedSave) {
      const r = await saveBacktest({ id: editedSave.id, name: editName, query: current });
      setEditing(null);
      return `Saved the changes to "${r.save.name}"${r.save.name !== editedSave.name ? ` (it was "${editedSave.name}")` : ''}.`;
    }
    const was = editedPortfolio!;
    const r = await savePortfolio({ id: was.id, name: editName, saveIds: picked });
    // A run of it on the screen is of what it is now.
    if (run?.title === was.name) setRun({ ids: r.portfolio.saveIds, title: r.portfolio.name });
    setEditing(null);
    return `Saved the changes to the portfolio "${r.portfolio.name}"${r.portfolio.name !== was.name ? ` (it was "${was.name}")` : ''}: ${r.portfolio.saveIds.length} saved backtests.`;
  });
  const keepPortfolio = () => act(async () => {
    const r = await savePortfolio({ name: portfolioName, saveIds: picked });
    setPortfolioName('');
    return `Kept as the portfolio "${r.portfolio.name}".`;
  });

  const single = mode === 'single';
  const savedRow = (s: BacktestSave) => (
    <li key={s.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-0 border-t border-solid border-[var(--line-soft)] py-2 first:border-t-0">
      <button type="button" aria-label={`Run ${s.name}`} aria-current={shown?.id === s.id ? 'true' : undefined}
        onClick={() => { onLoad(s.query); setFromId(s.id); setSaid(null); }}
        className="m-0 min-h-[44px] min-w-0 appearance-none border-0 bg-transparent p-0 text-left font-[inherit]">
        <span className={cn('block text-[14px] font-semibold [overflow-wrap:anywhere]', shown?.id === s.id ? 'text-[var(--chosen)]' : 'text-foreground')}>{s.name}{shown?.id === s.id ? ' · on the screen' : ''}</span>
        <span className="block text-[12px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{wordsOf(s.query)}</span>
      </button>
      {asking === s.id ? (
        <span className="flex items-center gap-2 pt-1">
          <button type="button" disabled={busy} onClick={() => void remove(s)} className="m-0 min-h-[36px] appearance-none border-0 bg-transparent p-0 font-[inherit] text-[13px] font-semibold text-[var(--down)]">Delete</button>
          <button type="button" onClick={() => setAsking(null)} className={link}>Keep</button>
        </span>
      ) : (
        <span className="flex items-center">
          <button type="button" aria-label={`Edit ${s.name}`} aria-pressed={editedSave?.id === s.id} onClick={() => editSave(s)}
            className={cn(link, 'h-11 px-1.5', editedSave?.id === s.id && 'font-semibold underline')}>Edit</button>
          <button type="button" aria-label={`Delete ${s.name}`} onClick={() => setAsking(s.id)}
            className="m-0 grid h-11 w-8 appearance-none place-items-center border-0 bg-transparent p-0 text-[18px] text-muted-foreground">×</button>
        </span>
      )}
    </li>
  );
  /** In the portfolio section a saved backtest is a tick: the whole row is the box's own label. */
  const tickRow = (s: BacktestSave) => {
    const on = picked.includes(s.id);
    return (
      <li key={s.id} className="border-0 border-t border-solid border-[var(--line-soft)] first:border-t-0">
        <label className={cn('grid min-h-[44px] cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 rounded-md px-1 py-2', on && 'bg-[var(--chosen-soft)]')}>
          <input type="checkbox" checked={on} aria-label={`Run ${s.name} together with others`} disabled={!on && picked.length >= 12}
            onChange={() => setTicked((t) => (t.includes(s.id) ? t.filter((x) => x !== s.id) : [...t, s.id]))}
            className="mt-0.5 h-5 w-5 accent-[var(--chosen)]" />
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold [overflow-wrap:anywhere]">{s.name}</span>
            <span className="block text-[12px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{wordsOf(s.query)}</span>
          </span>
        </label>
      </li>
    );
  };
  const saidLine = said && <p role={said.tone === 'bad' ? 'alert' : 'status'} className={cn('m-0 text-[13px]', said.tone === 'bad' ? 'text-[var(--down)]' : 'text-[var(--up)]')}>{said.text}</p>;
  const howMany = single
    ? `${saves.length} saved`
    : `${portfolios.length} portfolio${portfolios.length === 1 ? '' : 's'} · ${saves.length} saved backtest${saves.length === 1 ? '' : 's'}`;

  return (
      <Panel title={single ? 'Saved backtests' : 'Portfolios'} right={<span className="text-[11.5px] text-muted-foreground">{howMany}</span>}>
        {failed && !list ? <p role="alert" className="m-0 text-[13px] text-[var(--down)]">The saved backtests could not be read: {failed}</p> : !list ? <Loading error={null} what="the saved backtests" /> : single ? (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
            {/* Keep what is on the screen -- or, while a saved one is edited, the changes to it. */}
            {editedSave ? (
              <form aria-label={`Edit ${editedSave.name}`} className="grid gap-1.5 rounded-md border border-solid border-[var(--accent)] px-2.5 py-2"
                onSubmit={(e) => { e.preventDefault(); if (editName.trim() && !busy) void saveEdit(); }}>
                <p className="m-0 text-[13px] leading-snug">
                  Editing <b className="font-semibold">{editedSave.name}</b>. Its settings are on the screen: change them above, and its name here.
                </p>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={60} aria-label="Name of the saved backtest" className={field} />
                <p className="m-0 text-[12px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">
                  {shapeOf(editedSave.query) === shape ? 'Settings unchanged so far.' : `It will be: ${wordsOf(current)}`}
                </p>
                <span className="flex gap-2">
                  <button type="submit" disabled={!editName.trim() || busy || (shapeOf(editedSave.query) === shape && editName.trim() === editedSave.name)} className={cn(solid, 'flex-1')}>Save changes</button>
                  <button type="button" className={quiet} onClick={() => { setEditing(null); setSaid(null); }}>Cancel</button>
                </span>
              </form>
            ) : shown ? (
              <p className="m-0 text-[13px] text-muted-foreground">The settings on the screen are saved as <b className="font-semibold text-foreground">{shown.name}</b>.</p>
            ) : (
              <form className="grid gap-1.5" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !busy) void keep(); }}>
                <label className="grid gap-1">
                  <span className="text-[12px] text-muted-foreground">Save the settings on the screen as</span>
                  <span className="flex min-w-0 gap-2">
                    <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Name for the saved backtest" placeholder="A name, e.g. 1h delta 0.10, dynamic target" className={field} />
                    <button type="submit" disabled={!name.trim() || busy} className={solid}>Save</button>
                  </span>
                </label>
                {from && (
                  <button type="button" disabled={busy} onClick={() => void keep(from.id)} className={cn(link, 'justify-self-start text-left')}>
                    Or update “{from.name}” to these settings
                  </button>
                )}
              </form>
            )}
            {saidLine}
            {saves.length === 0
              ? <Empty>Nothing saved yet. Set the backtest up as you want it, give it a name and Save: it can be run again in one tap, and several run together under Portfolio.</Empty>
              : <ul aria-label="Saved backtests" className="m-0 grid list-none gap-0 p-0">{saves.map(savedRow)}</ul>}
          </div>
        ) : (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
            {saidLine}
            {/* The portfolios kept, first: one tap runs one. */}
            {portfolios.length > 0 && (
              <ul aria-label="Portfolios" className="m-0 grid list-none gap-0 p-0">
                {portfolios.map((p) => {
                  const on = run !== null && run.title === p.name;
                  return (
                    <li key={p.id} className={cn('grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-1.5 border-0 border-t border-solid border-[var(--line-soft)] py-1.5 first:border-t-0', on && 'rounded-md bg-[var(--chosen-soft)] px-1.5')}>
                      <span className="min-w-0">
                        <span className={cn('block text-[14px] font-semibold [overflow-wrap:anywhere]', on && 'text-[var(--chosen)]')}>{p.name}{on ? ' · running' : ''}</span>
                        <span className="block text-[12px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{p.saveIds.map(nameOf).join(' + ')}</span>
                      </span>
                      <button type="button" aria-label={`Run the portfolio ${p.name}`} className={cn(on ? quiet : solid, 'h-10')} onClick={() => setRun({ ids: p.saveIds, title: p.name })}>Run</button>
                      <button type="button" aria-label={`Edit the portfolio ${p.name}`} aria-pressed={editedPortfolio?.id === p.id} onClick={() => editPortfolio(p)}
                        className={cn(link, 'h-10 px-1', editedPortfolio?.id === p.id && 'font-semibold underline')}>Edit</button>
                      <button type="button" aria-label={`Delete the portfolio ${p.name}`} disabled={busy}
                        onClick={() => void act(async () => { await deletePortfolio(p.id); if (run?.title === p.name) setRun(null); if (editedPortfolio?.id === p.id) setEditing(null); return `Deleted the portfolio "${p.name}". Its saved backtests are kept.`; })}
                        className="m-0 grid h-10 w-9 appearance-none place-items-center border-0 bg-transparent p-0 text-[18px] text-muted-foreground">×</button>
                    </li>
                  );
                })}
              </ul>
            )}
            {saves.length < 2 ? (
              <Empty>A portfolio is two saved backtests or more, run together. Save them under Single backtest first{saves.length === 1 ? ' -- there is one so far' : ''}.</Empty>
            ) : (
              <section aria-label="Saved backtests to run together" className="grid gap-1">
                <h3 className="m-0 text-[12px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">{editedPortfolio ? `In “${editedPortfolio.name}”` : portfolios.length ? 'Or tick saved backtests' : 'Tick saved backtests'}</h3>
                <ul aria-label="Saved backtests" className="m-0 grid list-none gap-0 p-0">{saves.map(tickRow)}</ul>
              </section>
            )}
            {/* A portfolio being edited: its members are the ticks above, its name here. */}
            {editedPortfolio && (
              <form aria-label={`Edit the portfolio ${editedPortfolio.name}`} className="grid gap-1.5 rounded-md border border-solid border-[var(--accent)] px-2.5 py-2"
                onSubmit={(e) => { e.preventDefault(); if (editName.trim() && picked.length >= 2 && !busy) void saveEdit(); }}>
                <p className="m-0 text-[13px] leading-snug">
                  Editing the portfolio <b className="font-semibold">{editedPortfolio.name}</b>. Tick or untick the saved backtests above to change what is in it, and its name here.
                </p>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={60} aria-label="Name of the portfolio" className={field} />
                <p role={picked.length < 2 ? 'alert' : undefined} className={cn('m-0 text-[12px] leading-snug [overflow-wrap:anywhere]', picked.length < 2 ? 'text-[var(--down)]' : 'text-muted-foreground')}>
                  {picked.length < 2 ? 'A portfolio is two saved backtests or more: tick another.' : `In it: ${picked.map(nameOf).join(' + ')}.`}
                </p>
                <span className="flex gap-2">
                  <button type="submit" disabled={!editName.trim() || picked.length < 2 || busy} className={cn(solid, 'flex-1')}>Save changes</button>
                  <button type="button" className={quiet} onClick={() => { setEditing(null); setTicked([]); setSaid(null); }}>Cancel</button>
                </span>
              </form>
            )}
            {/* Two or more ticked: run them together, and keep the set. */}
            {saves.length >= 2 && !editedPortfolio && (
              <div className="grid gap-2 rounded-md bg-muted px-2.5 py-2">
                <p className="m-0 text-[12.5px] leading-snug text-muted-foreground">
                  {picked.length < 2 ? 'Tick two or more to run them together and see what they come to as one.' : `${picked.length} ticked: ${picked.map(nameOf).join(', ')}.`}
                </p>
                {picked.length >= 2 && (
                  <>
                    <button type="button" className={cn(solid, 'w-full')} onClick={() => setRun({ ids: picked, title: picked.map(nameOf).join(' + ') })}>Run these {picked.length} together</button>
                    <span className="text-[12px] text-muted-foreground">Or keep these {picked.length} as a portfolio, to run again in one tap:</span>
                    <form className="flex min-w-0 gap-2" onSubmit={(e) => { e.preventDefault(); if (portfolioName.trim() && !busy) void keepPortfolio(); }}>
                      <input value={portfolioName} onChange={(e) => setPortfolioName(e.target.value)} maxLength={60} aria-label="Name for the portfolio" placeholder="Portfolio name" className={field} />
                      <button type="submit" disabled={!portfolioName.trim() || busy} className={quiet}>Keep</button>
                    </form>
                  </>
                )}
              </div>
            )}

          </div>
        )}
      </Panel>
  );
}
