import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SignalHistory, cleanFilter, seenText, stopOf, exitNote, exitOf, fillNote, outcomeOf, startOfIstDay, stood } from './SignalHistory';
import type { EntrySignal, EntrySignalOutcome, EntrySignalPage } from '@/types/entry';

const getEntrySignals = vi.fn();
vi.mock('@/api/entry', async (real) => ({ ...(await real<typeof import('@/api/entry')>()), getEntrySignals: (...a: unknown[]) => getEntrySignals(...a) }));

const T = Date.UTC(2026, 8, 30, 14, 33);
const S = T / 1000;
/** A paper-log outcome: the fields the server always sends, then the case's own. */
const oc = (over: Partial<EntrySignalOutcome> = {}): EntrySignalOutcome => ({
  status: 'open', fillPrice: null, exitPrice: null, exitAt: null, rNet: null, filledAt: null, fillBy: S + 3_600, timeoutAt: null,
  fillEdge: 84_391, fillBetterPts: null, exitLevel: null, exitPastPts: null, exitWhy: null,
  tp1At: null, tp2At: null, tp3At: null, runner: null, runnerEnd: null, expireWhy: null, ...over,
});
const sig = (over: Partial<EntrySignal> = {}): EntrySignal => ({
  method: 'fvg-retest', n: 4, name: 'FVG retest', mode: 'single', tf: '3m', dir: -1, state: 'TRADE',
  triggerAt: 1, firstSeen: T, lastSeen: T + 12 * 60_000, score: 50, reason: 'short -- FVG retest on 3m',
  entryLo: 84_391, entryHi: 84_523, stop: 84_825, tp1: 84_288, rr: 1.9, gatesOff: [], ltp: 84_402.5, indexPrice: 84_380.1,
  outcome: oc({ status: 'tp1', fillPrice: 84_391, exitPrice: 84_288, exitAt: S + 30 * 60, rNet: 0.21, filledAt: S + 120, fillBetterPts: 0, exitLevel: 84_288, exitPastPts: 0, exitWhy: 'level' }),
  barCloseAt: S - 3, seenAfterMs: 3_000, alert: { at: T + 1_000, status: 'sent' }, tp2: null, tp3: null, why: null, ...over,
});
const SUMMARY = { trades: 9, tp1: 4, tp1Pts: 1_210, stops: 3, slPts: 960, timeouts: 1, timeoutPts: -70, netPts: 180, open: 1, tp2: 2, tp3: 1 };
const page = (signals: EntrySignal[], total = signals.length): EntrySignalPage => ({ signals, total, summary: SUMMARY });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getEntrySignals.mockResolvedValue(page([
    sig(),
    sig({ state: 'WAIT', dir: 1, method: 'bos', n: 6, name: 'BOS', mode: 'mtf', tf: '5m', entryLo: null, entryHi: null, stop: null, tp1: null, rr: null, outcome: null, gatesOff: ['rr'], triggerAt: 2 }),
    sig({ dir: 1, triggerAt: 3, entryLo: 84_000, entryHi: 84_040, stop: 83_800, tp1: 84_300, outcome: oc({ status: 'stop', fillPrice: 84_000, exitPrice: 83_778, exitAt: S + 600, rNet: -1.1, filledAt: S + 60, fillEdge: 84_040, fillBetterPts: 40, exitLevel: 83_800, exitPastPts: 22, exitWhy: 'gap' }) }),
  ], 60));
});

describe('the signal history table', () => {
  it('[critical] each signal in full: when, the price then (LTP · index), levels, fill → exit and why, the result in points and R', async () => {
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    const [trade, wait, stopped] = within(table).getAllByRole('row').slice(1);
    expect(trade).toHaveTextContent('20:03');
    expect(trade).toHaveTextContent('#4 FVG retest');
    expect(trade).toHaveTextContent('Without · 3m');
    expect(trade).toHaveTextContent('SELL');
    expect(trade).toHaveTextContent('84,403 · 84,380');
    expect(trade).toHaveTextContent('84,391~20:05'); // Entry: the fill and its minute
    expect(trade).toHaveTextContent('84,288 TGT~20:33'); // Exit: the price, by TGT, and its minute
    expect(trade).toHaveTextContent('TP1 ✓ +0.21R (+103 pts)');
    expect(wait).toHaveTextContent('WAIT BUY');
    expect(wait).toHaveTextContent('gates off');
    expect(wait).toHaveTextContent('waited');
    expect(stopped).toHaveTextContent('83,778 SL');
    expect(stopped).toHaveTextContent('stop ✗ −1.10R (−222 pts)');
  });

  it('[critical] the totals over every match, not just the page -- and they add up: net = target pts − SL pts ± time-out pts; no Net R', async () => {
    render(<SignalHistory />);
    const t = await screen.findByLabelText('history totals');
    expect(t).toHaveTextContent('TRADEs98 closed · 1 open');
    expect(t).toHaveTextContent('TGT1 hits4+1,210 pts');
    expect(t).toHaveTextContent('SL hits3−960 pts');
    expect(t).toHaveTextContent('Timed out1−70 pts');
    expect(t).toHaveTextContent('TGT2 · TGT32 · 1');
    expect(t).toHaveTextContent('Net pts+180= +1,210 − 960 − 70');
    expect(t).not.toHaveTextContent(/Net R|fees/);
  });

  it('[critical] signal tabs: All, TRADING, BUY & SELL, BUY, SELL, WAIT, then each ending -- each asks the server for exactly that', async () => {
    render(<SignalHistory />);
    await screen.findByRole('table', { name: 'signals' });
    const tabs = screen.getByRole('tablist', { name: 'signal tabs' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['All', 'TRADING', 'BUY & SELL', 'BUY', 'SELL', 'WAIT', 'TGT HIT', 'SL HIT', 'TIMED OUT', 'EXPIRED']);
    const last = () => getEntrySignals.mock.lastCall![0];
    fireEvent.click(within(tabs).getByRole('tab', { name: 'TRADING' }));
    await waitFor(() => expect(last()).toMatchObject({ state: 'TRADE', live: true })); // in play now: at the zone or filled
    fireEvent.click(within(tabs).getByRole('tab', { name: 'BUY' }));
    await waitFor(() => { expect(last()).toMatchObject({ state: 'TRADE', dir: 1 }); expect(last().live).toBeUndefined(); });
    fireEvent.click(within(tabs).getByRole('tab', { name: 'SELL' }));
    await waitFor(() => expect(last()).toMatchObject({ state: 'TRADE', dir: -1 }));
    fireEvent.click(within(tabs).getByRole('tab', { name: 'BUY & SELL' }));
    await waitFor(() => { expect(last()).toMatchObject({ state: 'TRADE' }); expect(last().dir).toBeUndefined(); });
    fireEvent.click(within(tabs).getByRole('tab', { name: 'WAIT' }));
    await waitFor(() => expect(last()).toMatchObject({ state: 'WAIT' }));
    expect(within(tabs).getByRole('tab', { name: 'WAIT' })).toHaveAttribute('aria-selected', 'true');
    // How each TRADE ended: exactly that ending, and only TRADEs; never a leftover filter from another tab.
    for (const [name, outcome] of [['TGT HIT', 'tp1'], ['SL HIT', 'stop'], ['TIMED OUT', 'timeout'], ['EXPIRED', 'expired']] as const) {
      fireEvent.click(within(tabs).getByRole('tab', { name }));
      await waitFor(() => expect(last()).toMatchObject({ state: 'TRADE', outcome }));
      expect(last().dir).toBeUndefined();
      expect(last().live).toBeUndefined();
    }
    fireEvent.click(within(tabs).getByRole('tab', { name: 'BUY' }));
    await waitFor(() => { expect(last()).toMatchObject({ state: 'TRADE', dir: 1 }); expect(last().outcome).toBeUndefined(); });
  });

  it('[critical] pages: "1–25 of 60", next and previous ask for the right offset, the page size is a choice', async () => {
    render(<SignalHistory />);
    const nav = await screen.findByRole('navigation', { name: 'history pages' });
    expect(nav).toHaveTextContent('1–25 of 60');
    expect(nav).toHaveTextContent('Page 1 of 3');
    expect(within(nav).getByRole('button', { name: 'previous page' })).toBeDisabled();
    fireEvent.click(within(nav).getByRole('button', { name: 'next page' }));
    await waitFor(() => expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ offset: 25, limit: 25 }));
    await waitFor(() => expect(nav).toHaveTextContent('26–50 of 60'));
    fireEvent.click(within(within(nav).getByRole('group', { name: 'rows per page' })).getByRole('button', { name: '50' }));
    await waitFor(() => expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ offset: 0, limit: 50 })); // a new size starts at the first page
  });

  it('[critical] every column sorts, both ways, on the server -- so the order holds across every page; no R:R column', async () => {
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent!.replace(/[▲▼↕]/g, ''));
    expect(heads).toEqual(['Signal time', 'Method', 'Way · TF', 'Signal', 'LTP · Index', 'Entry zone', 'SL', 'TGT1', 'TGT2', 'TGT3', 'Entry', 'Exit', 'Result', 'Quality', 'Stood']);
    expect(within(table).getByRole('columnheader', { name: /Signal time/ })).toHaveAttribute('aria-sort', 'descending');
    for (const [name, sort] of [['Method', 'method'], ['SL', 'sl'], ['TGT2', 'tp2'], ['Exit', 'exit'], ['Result', 'result'], ['Stood', 'stood']] as const) {
      fireEvent.click(within(await screen.findByRole('table', { name: 'signals' })).getByRole('button', { name: new RegExp(`^${name}`) }));
      await waitFor(() => expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ sort, asc: undefined }));
    }
    fireEvent.click(within(await screen.findByRole('table', { name: 'signals' })).getByRole('button', { name: /^Stood/ }));
    await waitFor(() => expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ sort: 'stood', asc: true }));
    expect(within(await screen.findByRole('table', { name: 'signals' })).getByRole('columnheader', { name: /Stood/ })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('[critical] TGT1 / TGT2 / TGT3 each say what became of them: reached and when, still watched, or not reached', async () => {
    getEntrySignals.mockResolvedValue(page([
      sig({ tp2: 84_100, tp3: 83_900, outcome: oc({ status: 'tp1', fillPrice: 84_391, exitPrice: 84_288, exitAt: S + 600, tp1At: S + 600, tp2At: S + 900, runner: 'running', filledAt: S + 60, timeoutAt: S + 9_999 }) }),
      sig({ triggerAt: 7, tp2: 84_100, tp3: null, outcome: oc({ status: 'stop', fillPrice: 84_391, exitPrice: 84_830, exitAt: S + 600, filledAt: S + 60 }) }),
    ]));
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    const [run, stopped] = within(table).getAllByRole('row').slice(1);
    expect(within(run!).getByLabelText('TGT1')).toHaveTextContent('84,288✓ ~20:13');
    expect(within(run!).getByLabelText('TGT2')).toHaveTextContent('84,100✓ ~20:18');
    expect(within(run!).getByLabelText('TGT3')).toHaveTextContent('83,900watching…');
    expect(within(run!).getByLabelText('counter')).toHaveTextContent('Runner, stop at breakeven TGT2 ✓ · TGT3 next');
    expect(within(stopped!).getByLabelText('TGT1')).toHaveTextContent('84,288✗ not reached');
    expect(within(stopped!).getByLabelText('TGT3')).toHaveTextContent('–');
  });

  it('[critical] the Excel download is every row the filters match, in this order -- the server builds it', async () => {
    render(<SignalHistory />);
    await screen.findByRole('table', { name: 'signals' });
    fireEvent.click(within(screen.getByRole('tablist', { name: 'signal tabs' })).getByRole('tab', { name: 'SELL' }));
    const link = await screen.findByRole('link', { name: 'download for Excel' });
    await waitFor(() => expect(link.getAttribute('href')).toMatch(/^\/api\/entry\/signals\.csv\?/));
    const q = new URLSearchParams(link.getAttribute('href')!.split('?')[1]);
    expect([q.get('state'), q.get('dir'), q.get('sort'), q.get('limit'), q.get('offset')]).toEqual(['TRADE', '-1', 'time', null, null]);
    expect(link).toHaveTextContent('Excel · 60');
  });

  it('filters -- way, timeframe, today -- go to the server and are remembered', async () => {
    render(<SignalHistory />);
    await screen.findByRole('table', { name: 'signals' });
    expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ since: startOfIstDay(Date.now()) });
    fireEvent.click(within(screen.getByRole('group', { name: 'history way' })).getByRole('button', { name: 'With TF' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'history timeframe' })).getByRole('button', { name: '15m' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'history range' })).getByRole('button', { name: 'All days' }));
    await waitFor(() => expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ mode: 'mtf', tf: '15m', since: undefined }));
    expect(JSON.parse(localStorage.getItem('btc-desk:entry:history-table')!)).toMatchObject({ mode: 'mtf', tf: '15m', today: false });
  });

  it('with nothing for the filters, it says so in words', async () => {
    getEntrySignals.mockResolvedValue(page([], 0));
    render(<SignalHistory />);
    expect(await screen.findByText(/No signals for these filters yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'TRADING' }));
    expect(await screen.findByText(/Nothing in play right now/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'EXPIRED' }));
    expect(await screen.findByText('No TRADE ended EXPIRED for these filters.', { exact: false })).toBeInTheDocument();
  });

  it('the pieces: how long it stood, what became of it, the exit and why, the desk\'s day', () => {
    expect([stood(20_000), stood(4 * 60_000), stood(72 * 60_000)]).toEqual(['just now', '4 min', '1 h 12 min']);
    expect(outcomeOf(sig({ outcome: oc({ status: 'open' }) })).text).toBe('waiting for price');
    expect(outcomeOf(sig({ outcome: oc({ status: 'expired' }) })).text).toBe('expired, never filled');
    expect(outcomeOf(sig({ outcome: oc({ status: 'expired', expireWhy: 'target' }) })).text).toBe('expired, never filled -- price ran to TGT1 without it');
    expect(outcomeOf(sig({ outcome: oc({ status: 'expired', expireWhy: 'stop' }) })).text).toBe('expired, never filled -- SL broken before the fill');
    expect(exitOf(sig())).toEqual({ price: '84,288', why: 'TGT', pts: 103 });
    expect(exitOf(sig({ outcome: oc({ status: 'timeout', fillPrice: 84_391, exitPrice: 84_400, exitAt: S, rNet: -0.1, exitWhy: 'time' }) }))).toEqual({ price: '84,400', why: 'time', pts: -9 });
    expect(exitOf(sig({ outcome: oc({ status: 'filled', fillPrice: 84_391 }) }))).toBeNull();
    // 00:00 IST on 1 Oct 2026 is 18:30 UTC on 30 Sep.
    expect(startOfIstDay(Date.UTC(2026, 8, 30, 20, 0))).toBe(Date.UTC(2026, 8, 30, 18, 30));
  });

  it('[critical] when, to the second: the signal, its bar\'s close and how soon it was seen, the alert; when it filled and went out', async () => {
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    const [trade, , stopped] = within(table).getAllByRole('row').slice(1);
    expect(trade).toHaveTextContent('trigger bar 20:02:57 · seen +3 s');
    expect(trade).toHaveTextContent('alert ✓ 20:03:01 +4 s');
    expect(trade).toHaveTextContent('84,391~20:05 · at edge');
    expect(trade).toHaveTextContent('84,288 TGT~20:33 · at level');
    expect(stopped).toHaveTextContent('84,000~20:04 · 40 better');
    expect(stopped).toHaveTextContent('83,778 SL~20:13 · 22 past (slipped)');
    // The whole sentence on hover, kept short in the cell.
    expect(within(stopped!).getByTitle('fill 40 pts better than the 84,040 edge -- opened inside the zone')).toBeInTheDocument();
    expect(within(stopped!).getByTitle('exit 22 pts past SL 83,800 -- the first trade through it, or the minute opening past it (slipped)')).toBeInTheDocument();
    expect(within(trade!).getByTitle('exit exactly at TGT 84,288')).toBeInTheDocument();
  });

  it('[critical] a TRADE still in play counts: the fill window closing, then the time in the trade and to the time-out', async () => {
    const now = Date.now();
    const s0 = Math.floor(now / 1000);
    getEntrySignals.mockResolvedValue(page([
      sig({ outcome: oc({ status: 'open', fillBy: s0 + 125 }) }),
      sig({ triggerAt: 9, outcome: oc({ status: 'filled', fillPrice: 84_391, filledAt: s0 - 65, timeoutAt: s0 + 3_600 }) }),
    ]));
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    const [waiting, inTrade] = within(table).getAllByRole('row').slice(1);
    expect(within(waiting!).getByLabelText('counter')).toHaveTextContent(/Fill window closes in 2:0[45]/);
    expect(within(inTrade!).getByLabelText('counter')).toHaveTextContent(/In the trade 1:0[5-7] · time-out in (1:00:00|59:5\d)/);
  });

  it('the exit and fill notes in words', () => {
    expect(exitNote(sig())).toEqual({ text: 'exactly at TGT 84,288', gap: false });
    expect(exitNote(sig({ outcome: oc({ status: 'stop', exitPrice: 83_441, exitLevel: 83_463, exitPastPts: 22, exitWhy: 'gap' }) })))
      .toEqual({ text: '22 pts past SL 83,463 -- the first trade through it, or the minute opening past it (slipped)', gap: true });
    expect(exitNote(sig({ outcome: oc({ status: 'timeout', exitWhy: 'time' }) }))!.text).toBe('closed on time (48 bars), at the bar close');
    expect(exitNote(sig({ outcome: oc() }))).toBeNull();
    expect(fillNote(sig())).toBe('at the zone edge 84,391');
  });

  it('TGT2 and TGT3 in their own columns, and why the SL and each target are where they are on hover', async () => {
    getEntrySignals.mockResolvedValue(page([sig({ tp2: 84_100, tp3: 83_900, why: { stop: 'the displacement origin 84,520 + 0.25 ATR', tp1: 'entry swing low 84,288', tp2: '1h swing low 84,100', tp3: null } })]));
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    const [row] = within(table).getAllByRole('row').slice(1);
    expect(within(row!).getByLabelText('TGT2')).toHaveTextContent('84,100✗ not reached');
    expect(within(row!).getByLabelText('TGT3')).toHaveTextContent('83,900✗ not reached');
    expect(within(row!).getByTitle('the displacement origin 84,520 + 0.25 ATR')).toHaveTextContent('84,825');
    expect(within(row!).getByLabelText('TGT1')).toHaveAttribute('title', 'entry swing low 84,288');
    expect(within(row!).getByLabelText('TGT2')).toHaveAttribute('title', '1h swing low 84,100');
  });

  it('[critical] a filter saved before -- 1m, the R:R column, a page size gone -- is cleaned, so the list never hides behind a chip that is not there', async () => {
    expect(cleanFilter({ tf: '1m' as never, sort: 'rr' as never, size: 10 as never, tab: 'gone' as never, mode: 'x' as never }))
      .toEqual({ tab: 'all', mode: 'all', tf: 'all', today: true, size: 25, sort: 'time', asc: false });
    localStorage.setItem('btc-desk:entry:history-table', JSON.stringify({ tf: '1m', sort: 'rr' }));
    render(<SignalHistory />);
    await screen.findByRole('table', { name: 'signals' });
    expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ tf: undefined, sort: 'time' });
  });

  it('nothing yet today offers every day in one click', async () => {
    getEntrySignals.mockResolvedValue(page([], 0));
    render(<SignalHistory />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show all days' }));
    await waitFor(() => expect(getEntrySignals.mock.lastCall![0].since).toBeUndefined());
  });

  it('[critical] seen a minute or less after its trigger bar is latency; an older trigger bar is not a delay, and says the time instead', () => {
    expect(seenText({ barCloseAt: S, seenAfterMs: 3_000, firstSeen: T + 3_000 })).toBe('trigger bar 20:03:00 · seen +3 s');
    // A retest anchored to the 06:51 bar, formed at 06:55:03 -- not "+4 min 3 s" of lag.
    expect(seenText({ barCloseAt: S, seenAfterMs: 243_000, firstSeen: T + 243_000 })).toBe('trigger bar 20:03:00 · formed 20:07:03');
  });

  it('[critical] a time the live tape graded is to the second; one a 1m candle graded is that minute, "~"', async () => {
    getEntrySignals.mockResolvedValue(page([sig({ outcome: oc({ status: 'tp1', fillPrice: 84_391, filledAt: S + 137, exitPrice: 84_288, exitAt: S + 600, tp1At: S + 600 }) })]));
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    const [r] = within(table).getAllByRole('row').slice(1);
    expect(r).toHaveTextContent('84,39120:05:17'); // the fill, off the tape
    expect(r).toHaveTextContent('84,288 TGT~20:13'); // the exit, off a candle
  });

  it('Clear filters shows only when something is set, and puts every filter back', async () => {
    render(<SignalHistory />);
    await screen.findByRole('table', { name: 'signals' });
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    fireEvent.click(within(screen.getByRole('group', { name: 'history timeframe' })).getByRole('button', { name: '1h' }));
    fireEvent.click(screen.getByRole('tab', { name: 'SL HIT' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      const q = getEntrySignals.mock.lastCall![0];
      expect([q.tf, q.outcome, q.state, q.since]).toEqual([undefined, undefined, undefined, startOfIstDay(Date.now())]);
    });
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('[critical] the SL says what became of it: guarding the order, watching, hit and when, at breakeven for the runner, never hit, or not filled', () => {
    const at = (o: Partial<EntrySignalOutcome>) => stopOf(sig({ outcome: oc(o) }))!.text;
    expect(at({ status: 'open' })).toBe('guards the order');
    expect(at({ status: 'filled', fillPrice: 84_391 })).toBe('watching…');
    expect(at({ status: 'stop', exitAt: S + 137 })).toMatch(/^✗ hit \d\d:\d\d:17$/);
    expect(at({ status: 'tp1', runner: 'running', fillPrice: 84_391 })).toBe('→ breakeven 84,391');
    expect(at({ status: 'tp1', runner: 'done', runnerEnd: 'be' })).toBe('✓ never hit · runner out at BE');
    expect(at({ status: 'timeout' })).toBe('✓ never hit');
    expect(at({ status: 'expired' })).toBe('not filled');
    expect(at({ status: 'expired', expireWhy: 'stop' })).toBe('broken before the fill');
    expect(at({ status: 'expired', expireWhy: 'target' })).toBe('not filled');
    expect(stopOf(sig({ state: 'WAIT', outcome: null }))).toBeNull();
  });

  it('the SL column shows it in the table', async () => {
    getEntrySignals.mockResolvedValue(page([sig({ outcome: oc({ status: 'filled', fillPrice: 84_391, filledAt: S + 60 }) })]));
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    expect(within(table).getByLabelText('SL')).toHaveTextContent('84,825watching…');
  });

  it('[critical] every method in one history, each by its number', async () => {
    getEntrySignals.mockResolvedValue(page([sig({ method: 'orb', n: 16, code: '16', name: 'Opening-range breakout (Asia · London · New York)' })]));
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    expect(getEntrySignals.mock.lastCall![0].track).toBeUndefined();
    expect(screen.queryByRole('group', { name: 'history methods' })).toBeNull();
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('#16 Opening-range breakout (Asia · London · New York)');
  });
});
