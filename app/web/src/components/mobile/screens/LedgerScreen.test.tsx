import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';
import type { Ledger, LedgerDay, LedgerSync, WalletDay } from '@/api/ledger';
import { signedInr, usdToInr } from '@/lib/format';

/**
 * The ledger on the phone (owner, 29 Oct 2026: "day by day -- profit, loss, charges, others; my system's P&L and the
 * Delta app's reconciled, checked at 11:59 PM and synced by hand -- user friendly, mobile friendly").
 */
const getLedger = vi.fn();
const syncLedger = vi.fn();
const syncLedgerRange = vi.fn();
const getLedgerDay = vi.fn();
const cancelLedgerSync = vi.fn();
vi.mock('@/api/ledger', () => ({
  getLedger: (...a: unknown[]) => getLedger(...a), syncLedger: (...a: unknown[]) => syncLedger(...a), syncLedgerRange: (...a: unknown[]) => syncLedgerRange(...a),
  getLedgerDay: (...a: unknown[]) => getLedgerDay(...a), cancelLedgerSync: (...a: unknown[]) => cancelLedgerSync(...a),
}));
const { LedgerScreen } = await import('@/components/mobile/screens/LedgerScreen');

const inr = (usd: number) => signedInr(usdToInr(usd));
const NOW = Date.parse('2026-10-29T15:00:00+05:30');
const wallet = (o: Partial<WalletDay> = {}): WalletDay => ({
  netUsd: 6.08, tradingUsd: 7.0, chargesUsd: -0.92, fundingUsd: 0, othersUsd: 0.1, transfersUsd: 50, openingUsd: 400, closingUsd: 456.18,
  entries: 1_830, byType: {}, unknownTypes: [], otherAssets: 0, complete: true, ...o,
});
const day = (d: string, o: Partial<LedgerDay> = {}): LedgerDay => ({
  day: d, desk: { realisedUsd: 7.0, profitUsd: 9.5, lossUsd: 2.5, chargesUsd: 0.92, netUsd: 6.08, trades: 214, open: 0 },
  status: 'match', diffUsd: 0, detail: '', delta: wallet(), checkedDeskUsd: 6.08, changed: false, checkedAt: Date.parse(`${d}T23:59:30+05:30`), how: 'auto', ...o,
});
const LEDGER = (o: Partial<Ledger> = {}): Ledger => ({
  from: '2026-10-23', to: '2026-10-29', account: null, accounts: [{ id: 1, name: 'High' }, { id: 2, name: 'Low' }], busy: false,
  lastAutoAt: Date.parse('2026-10-28T23:59:30+05:30'), toleranceUsd: 0.05,
  days: [
    day('2026-10-29', { status: 'unchecked', delta: null, diffUsd: null, checkedAt: null, how: null, checkedDeskUsd: null }),
    day('2026-10-28', {
      status: 'mismatch', diffUsd: 0.16, delta: wallet({ netUsd: 5.92, tradingUsd: 6.84 }), detail: 'Charges agree: the difference is in what the trades booked.',
      perAccount: [{ accountId: 1, name: 'High', status: 'mismatch', diffUsd: 0.16 }, { accountId: 2, name: 'Low', status: 'match', diffUsd: 0 }],
    }),
    day('2026-10-27', { changed: true, checkedDeskUsd: 5.5 }),
  ],
  totals: { desk: { realisedUsd: 21, profitUsd: 28.5, lossUsd: 7.5, chargesUsd: 2.76, netUsd: 18.24, trades: 642 }, delta: wallet({ othersUsd: 0.2, fundingUsd: 0 }), days: 3, checked: 2, matched: 1, mismatched: 1 },
  ...o,
});
const job = (o: Partial<LedgerSync> = {}): LedgerSync => {
  const days = o.days ?? ['2026-10-29', '2026-10-28', '2026-10-27', '2026-10-26', '2026-10-25', '2026-10-24', '2026-10-23'];
  return { id: 7, accountId: null, days, total: days.length, done: 0, day: days[0]!, status: 'running', error: null, resumed: 0, startedAt: NOW - 60_000, finishedAt: null, ...o };
};
const show = () => render(
  <PhoneContext.Provider value={{ now: NOW, accountParam: null, shown: 'all' } as unknown as PhoneData}>
    <LedgerScreen />
  </PhoneContext.Provider>,
);
const days = () => within(screen.getByRole('list', { name: 'Ledger days' }));

beforeEach(() => {
  window.localStorage.clear();
  getLedger.mockReset().mockResolvedValue(LEDGER());
  syncLedger.mockReset().mockResolvedValue({ sync: job({ days: ['2026-10-29'] }), already: false });
  syncLedgerRange.mockReset().mockResolvedValue({ sync: job(), already: false });
  getLedgerDay.mockReset().mockResolvedValue({ day: '2026-10-28', account: null, desk: day('2026-10-28').desk, trades: [] });
  cancelLedgerSync.mockReset().mockResolvedValue({ sync: job({ done: 2, day: null, status: 'cancelled', finishedAt: NOW }), cancelled: true });
});

describe('LedgerScreen', () => {
  it('[critical] the range\'s totals: net, profit, loss, charges, others -- and how many checked days matched Delta', async () => {
    show();
    const box = within(await screen.findByRole('region', { name: 'Ledger totals' }));
    expect(getLedger).toHaveBeenCalledWith('2026-10-23', '2026-10-29', null);
    expect(box.getByText('642 trades · 3 days')).toBeInTheDocument();
    const tile = (label: string) => box.getByText(label).nextSibling;
    expect(tile('Profit')).toHaveTextContent(inr(28.5));
    expect(tile('Loss')).toHaveTextContent(inr(-7.5));
    expect(tile('Charges')).toHaveTextContent(inr(-2.76));
    expect(tile('Others · Delta')).toHaveTextContent(inr(0.2));
    expect(within(box.getByLabelText('Reconciled with Delta')).getByText('1 of 2 checked match · 1 off · 1 not checked')).toBeInTheDocument();
    expect(screen.getByText(/Checked by itself every day at 11:59 PM\./)).toBeInTheDocument();
  });

  it('[critical] each day: its verdict, its four figures, Delta\'s net; a day changed since its check is said', async () => {
    show();
    await screen.findByRole('list', { name: 'Ledger days' });
    const row = (name: RegExp) => days().getByRole('button', { name });
    expect(within(row(/^Today/)).getByText('Not checked yet')).toBeInTheDocument();
    expect(within(row(/^Wed 28 Oct/)).getByText(`Off by ${inr(0.16).replace(/^[+−-]/, '')}`)).toBeInTheDocument();
    expect(within(row(/^Wed 28 Oct/)).getByText(/Delta/)).toHaveTextContent(`Delta ${inr(5.92)} · 214 trades`);
    expect(within(row(/^Tue 27 Oct/)).getByText('✓ Matches Delta')).toBeInTheDocument();
    expect(within(row(/^Tue 27 Oct/)).getByText(/changed since checked/)).toBeInTheDocument();
    expect(within(row(/^Today/)).getByText('Profit').nextSibling).toHaveTextContent(inr(9.5));
  });

  it('[critical] a day opened: the desk and Delta side by side, the difference and where it lies, each account\'s verdict', async () => {
    show();
    await screen.findByRole('list', { name: 'Ledger days' });
    fireEvent.click(days().getByRole('button', { name: /^Wed 28 Oct: open the day/ }));
    const box = within(screen.getByLabelText('The day, desk and Delta'));
    const cells = (label: string) => [...box.getByText(label).parentElement!.children].map((c) => c.textContent);
    expect(cells('Booked P&L')).toEqual(['Booked P&L', inr(7.0), inr(6.84)]);
    expect(cells('Charges')).toEqual(['Charges', inr(-0.92), inr(-0.92)]);
    expect(cells('Net')).toEqual(['Net', inr(6.08), inr(5.92)]);
    expect(box.getByText(`Difference ${inr(0.16)}`)).toBeInTheDocument();
    expect(box.getByText('Charges agree: the difference is in what the trades booked.')).toBeInTheDocument();
    expect(within(box.getByRole('list', { name: 'Each account' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([`High${`Off by ${inr(0.16).replace(/^[+−-]/, '')}`}`, 'Low✓ Matches Delta']);
    expect(box.getByText(/by itself/)).toBeInTheDocument();
    expect(box.getByText('Deposits & withdrawals').nextSibling).toHaveTextContent(inr(50));
  });

  it('[critical] Sync today asks for today on the account shown; Sync 7 days asks for the range shown; a day\'s own Sync asks for that day', async () => {
    show();
    await screen.findByRole('list', { name: 'Ledger days' });
    fireEvent.click(screen.getByRole('button', { name: 'Sync today' }));
    await waitFor(() => expect(syncLedger).toHaveBeenCalledWith(null, null));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync all 7 days with Delta' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Sync all 7 days with Delta' }));
    await waitFor(() => expect(syncLedgerRange).toHaveBeenCalledWith('2026-10-23', '2026-10-29', null));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync today' })).toBeEnabled());
    fireEvent.click(days().getByRole('button', { name: /^Tue 27 Oct: open the day/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sync this day' }));
    await waitFor(() => expect(syncLedger).toHaveBeenLastCalledWith('2026-10-27', null));
  });

  it('[critical] a sync the desk is running shows as running when the screen opens -- after a refresh as before it: both buttons held, how far it has got, the day it reads', async () => {
    getLedger.mockResolvedValue(LEDGER({ sync: job({ done: 2, day: '2026-10-27' }) }));
    show();
    await screen.findByRole('list', { name: 'Ledger days' });
    const range = screen.getByRole('button', { name: 'Checking 2 of 7 days' });
    expect(range).toBeDisabled();
    expect(range).toHaveTextContent('2 of 7…');
    expect(screen.getByRole('button', { name: 'Sync today' })).toBeDisabled();
    const status = screen.getByRole('status', { name: 'Sync with Delta, running' });
    expect(status).toHaveTextContent('Checking 7 days with Delta · now Tue 27 Oct');
    expect(status).toHaveTextContent(/carries on if you leave or refresh this screen/);
    expect(within(days().getByRole('button', { name: /^Tue 27 Oct/ })).getByText('Checking…')).toBeInTheDocument();
    // Asked every three seconds while it runs: the next answer finishes it, and the buttons come back.
    getLedger.mockResolvedValue(LEDGER({ sync: job({ done: 7, day: null, status: 'done', finishedAt: NOW }) }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync today' })).toBeEnabled(), { timeout: 5_000 });
    expect(screen.getByRole('status', { name: 'Sync with Delta, last' })).toHaveTextContent(/Last sync: 7 days, finished/);
  });

  it('[critical] the X beside a running sync stops it on the server, by its id, once: the buttons come back, and how far it got is said', async () => {
    getLedger.mockResolvedValue(LEDGER({ sync: job({ done: 2, day: '2026-10-27' }) }));
    let answer: (v: unknown) => void = () => {};
    cancelLedgerSync.mockImplementation(() => new Promise((r) => { answer = r; }));
    show();
    await screen.findByRole('list', { name: 'Ledger days' });
    const x = screen.getByRole('button', { name: 'Cancel sync' });
    fireEvent.click(x);
    // Asked once, by the id shown; while the server answers, a second tap does nothing.
    const held = await screen.findByRole('button', { name: 'Stopping the sync' });
    expect(held).toBeDisabled();
    fireEvent.click(held);
    expect(cancelLedgerSync).toHaveBeenCalledTimes(1);
    expect(cancelLedgerSync).toHaveBeenCalledWith(7);
    expect(screen.getByRole('status', { name: 'Sync with Delta, running' })).toHaveTextContent('Stopping…');
    getLedger.mockResolvedValue(LEDGER({ sync: job({ done: 2, day: null, status: 'cancelled', finishedAt: NOW }) }));
    answer({ sync: job({ done: 2, day: null, status: 'cancelled', finishedAt: NOW }), cancelled: true });
    expect(await screen.findByRole('status', { name: 'Sync with Delta, last' })).toHaveTextContent('Sync of 7 days cancelled after 2 of 7 days: those days are kept.');
    expect(screen.queryByRole('button', { name: 'Cancel sync' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync today' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sync all 7 days with Delta' })).toBeEnabled();
  });

  it('the X on a sync that had already finished says so; a stop the server refuses is said, and the sync still shows running', async () => {
    getLedger.mockResolvedValue(LEDGER({ sync: job({ days: ['2026-10-29'] }) }));
    cancelLedgerSync.mockResolvedValue({ sync: job({ days: ['2026-10-29'], done: 1, day: null, status: 'done', finishedAt: NOW }), cancelled: false });
    const { unmount } = show();
    await screen.findByRole('list', { name: 'Ledger days' });
    getLedger.mockResolvedValue(LEDGER({ sync: job({ days: ['2026-10-29'], done: 1, day: null, status: 'done', finishedAt: NOW }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sync' }));
    expect(await screen.findByText('It had already finished: nothing to stop.')).toBeInTheDocument();
    unmount();
    getLedger.mockResolvedValue(LEDGER({ sync: job({ days: ['2026-10-29'] }) }));
    cancelLedgerSync.mockRejectedValue(new Error('The desk did not answer.'));
    show();
    await screen.findByRole('list', { name: 'Ledger days' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sync' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The desk did not answer.');
    expect(screen.getByRole('button', { name: 'Cancel sync' })).toBeEnabled();
  });

  it('[critical] a tap while a sync runs starts nothing new: it is handed the one running, and says so', async () => {
    syncLedger.mockResolvedValue({ sync: job({ done: 3 }), already: true });
    show();
    await screen.findByRole('list', { name: 'Ledger days' });
    fireEvent.click(screen.getByRole('button', { name: 'Sync today' }));
    expect(await screen.findByText('A sync was already running (7 days): following it, nothing new started.')).toBeInTheDocument();
  });

  it('a sync Delta refuses is said, and the screen stays; a sync that stopped says why; no account switched on: nothing to check against', async () => {
    syncLedger.mockRejectedValue(new Error('Delta refused the request (unauthorized).'));
    const { unmount } = show();
    await screen.findByRole('list', { name: 'Ledger days' });
    fireEvent.click(screen.getByRole('button', { name: 'Sync today' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Delta refused the request (unauthorized).');
    unmount();
    getLedger.mockResolvedValue(LEDGER({ sync: job({ done: 2, status: 'failed', error: 'Stopped by 3 restarts in the middle: sync again.', finishedAt: NOW }) }));
    const stopped = show();
    expect(await screen.findByRole('status', { name: 'Sync with Delta, last' })).toHaveTextContent('The last sync (7 days) stopped after 2 of 7: Stopped by 3 restarts in the middle: sync again..');
    stopped.unmount();
    getLedger.mockResolvedValue(LEDGER({ accounts: [] }));
    show();
    expect(await screen.findByText(/No broker account is switched on/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync today' })).toBeDisabled();
  });

  it('[critical] a day opened offers its trades: one tap opens them in a sheet, for that day and the account shown', async () => {
    show();
    await screen.findByRole('list', { name: 'Ledger days' });
    fireEvent.click(days().getByRole('button', { name: /^Wed 28 Oct: open the day/ }));
    fireEvent.click(screen.getByRole('button', { name: /See the 214 trades/ }));
    expect(await screen.findByRole('dialog', { name: /Wed 28 Oct · trades/ })).toBeInTheDocument();
    expect(getLedgerDay).toHaveBeenCalledWith('2026-10-28', null);
    fireEvent.click(within(screen.getByRole('dialog', { name: /trades/ })).getAllByRole('button', { name: 'Close' })[0]!);
    expect(screen.queryByRole('dialog', { name: /trades/ })).not.toBeInTheDocument();
  });

  // Owner, 8 Nov 2026: "custom date on the ledger, and in it from the start of trading to today, dynamic".
  it('[critical] Custom: any From and To; Since start runs from the first trading day to today, and Sync takes its days', async () => {
    getLedger.mockResolvedValue(LEDGER({ firstDay: '2026-09-08' }));
    show();
    await screen.findByRole('region', { name: 'Ledger totals' });
    fireEvent.click(screen.getByRole('radio', { name: 'Custom range' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Custom range' }));
    fireEvent.click(sheet.getByRole('button', { name: 'Since start' }));
    expect(sheet.getByRole('status')).toHaveTextContent('Since start · 8 Sept – 29 Oct · 52 days');
    expect(sheet.getByRole('status')).toHaveTextContent('Moves with today');
    fireEvent.click(sheet.getByRole('button', { name: 'Show' }));

    await waitFor(() => expect(getLedger).toHaveBeenLastCalledWith('2026-09-08', '2026-10-29', null));
    expect(screen.getByRole('radio', { name: 'Custom range' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/^Since start · 8 Sept – 29 Oct/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sync all 52 days with Delta' }));
    await waitFor(() => expect(syncLedgerRange).toHaveBeenCalledWith('2026-09-08', '2026-10-29', null));

    // A fixed range typed by hand: no longer Since start.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    const again = within(screen.getByRole('dialog', { name: 'Custom range' }));
    expect(again.getByRole('button', { name: 'Since start' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(again.getByLabelText('From'), { target: { value: '2026-10-20' } });
    expect(again.getByRole('button', { name: 'Since start' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(again.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(getLedger).toHaveBeenLastCalledWith('2026-10-20', '2026-10-29', null));
  });

  it('[critical] Since start is dynamic: chosen days ago, it ends today and begins on the account\'s own first day', async () => {
    window.localStorage.setItem('btc-desk:m-ledger-range', JSON.stringify('custom'));
    window.localStorage.setItem('btc-desk:m-ledger-custom', JSON.stringify({ from: '2026-09-08', to: '2026-10-20', sinceStart: true }));
    getLedger.mockResolvedValue(LEDGER({ firstDay: '2026-10-05' }));
    show();
    await waitFor(() => expect(getLedger).toHaveBeenCalledWith('2026-09-08', '2026-10-29', null), { timeout: 2_000 });
    // The server's first day for this account replaces the one remembered; the end is today, not the day it was chosen.
    await waitFor(() => expect(getLedger).toHaveBeenLastCalledWith('2026-10-05', '2026-10-29', null));
    expect(JSON.parse(window.localStorage.getItem('btc-desk:m-ledger-custom')!)).toMatchObject({ from: '2026-10-05', sinceStart: true });
  });

  it('a custom range over the ledger\'s 92 days is stopped in the sheet, in words; Since start longer than that is the last 92, said', async () => {
    getLedger.mockResolvedValue(LEDGER({ firstDay: '2026-05-01' }));
    show();
    await screen.findByRole('region', { name: 'Ledger totals' });
    fireEvent.click(screen.getByRole('radio', { name: 'Custom range' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Custom range' }));
    fireEvent.change(sheet.getByLabelText('From'), { target: { value: '2026-07-01' } });
    expect(sheet.getByRole('alert')).toHaveTextContent('At most 92 days at a time.');
    expect(sheet.getByRole('button', { name: 'Show' })).toBeDisabled();
    fireEvent.click(sheet.getByRole('button', { name: 'Since start' }));
    expect(sheet.getByRole('status')).toHaveTextContent('92 days');
    expect(sheet.getByRole('status')).toHaveTextContent('Trading began 1 May; this shows at most the last 92 days.');
    fireEvent.click(sheet.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(getLedger).toHaveBeenLastCalledWith('2026-07-30', '2026-10-29', null));
  });
});
