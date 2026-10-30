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
vi.mock('@/api/ledger', () => ({ getLedger: (...a: unknown[]) => getLedger(...a), syncLedger: (...a: unknown[]) => syncLedger(...a), syncLedgerRange: (...a: unknown[]) => syncLedgerRange(...a) }));
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
});
