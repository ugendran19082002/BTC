import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BacktestSave, BacktestSaves, SavedQuery } from '@/types/signal-backtest';

const api = vi.hoisted(() => ({
  getBacktestSaves: vi.fn(), saveBacktest: vi.fn(), deleteBacktestSave: vi.fn(), cloneBacktestSave: vi.fn(),
  renameBacktestGroup: vi.fn(), savePortfolio: vi.fn(), deletePortfolio: vi.fn(), clonePortfolio: vi.fn(),
}));
vi.mock('@/api/backtest-saves', async (orig) => ({ ...(await orig<typeof import('@/api/backtest-saves')>()), ...api }));

const { SavedBacktests, agoWords } = await import('@/components/report/SavedBacktests');

const NOW = Date.now();
const q = (lots: number): SavedQuery => ({ params: { rule: 'delta', value: 0.1, lots, targetPct: 0.9, stopPct: 3, window: 'desk', deskMax: 0, cePct: 100, pePct: 100 }, tfs: [], methods: [], strategy: null } as SavedQuery);
const save = (id: string, name: string, lots: number, group: string | null = null, updatedAt = NOW - 3_600_000): BacktestSave => ({ id, name, group, query: q(lots), createdAt: 1, updatedAt });
const LIST: BacktestSaves = {
  saves: [save('a', '15m time', 1, '80% Win'), save('b', '1h time', 2, '80% Win', NOW - 60_000), save('c', '2h time', 3, '75% Win'), save('d', 'Loose one', 4)],
  portfolios: [{ id: 'p', name: 'High win', saveIds: ['a', 'b'], createdAt: 1, updatedAt: NOW - 86_400_000 * 2 }],
};
const words = (x: SavedQuery) => `${x.params.lots} lots`;
const show = (o: { mode?: 'single' | 'portfolio'; current?: SavedQuery; onLoad?: (x: SavedQuery) => void } = {}) =>
  render(<SavedBacktests mode={o.mode ?? 'single'} wide current={o.current ?? q(9)} wordsOf={words} onLoad={o.onLoad ?? (() => {})} run={null} onRun={() => {}} />);

beforeEach(() => {
  window.localStorage.clear();
  for (const f of Object.values(api)) f.mockReset();
  api.getBacktestSaves.mockResolvedValue(LIST);
});

describe('the saved backtests, a library (16 Oct 2026)', () => {
  it('[critical] in folders by group, each a tap to fold; a row says its group-free name, its settings and when it was changed', async () => {
    show();
    const g80 = await screen.findByRole('region', { name: 'Group 80% Win' });
    expect(within(g80).getAllByRole('button', { name: /^Run / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Run 15m time', 'Run 1h time']);
    expect(screen.getByRole('region', { name: 'Group No group' })).toHaveTextContent('Loose one');
    expect(within(g80).getByRole('button', { name: 'Run 1h time' }).parentElement).toHaveTextContent('Changed 1 min ago');
    fireEvent.click(within(g80).getByRole('button', { name: /80% Win/, expanded: true }));
    expect(within(screen.getByRole('region', { name: 'Group 80% Win' })).queryByRole('button', { name: 'Run 15m time' })).toBeNull();
    expect(screen.getByText('4 saved · 2 groups')).toBeInTheDocument();
  });

  it('[critical] found by a search over names, groups and settings; by a group\'s chip; in the order asked', async () => {
    show();
    await screen.findByRole('region', { name: 'Group 80% Win' });
    fireEvent.change(screen.getByLabelText('Search the saved backtests'), { target: { value: '3 lots' } });
    expect(screen.getAllByRole('button', { name: /^Run / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Run 2h time']);
    fireEvent.change(screen.getByLabelText('Search the saved backtests'), { target: { value: 'nothing like it' } });
    expect(screen.getByText(/Nothing matches "nothing like it"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show every one' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Which group' })).getByRole('button', { name: '75% Win 1' }));
    expect(screen.getAllByRole('button', { name: /^Run / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Run 2h time']);
    fireEvent.click(within(screen.getByRole('group', { name: 'Which group' })).getByRole('button', { name: 'All 4' }));
    fireEvent.change(screen.getByLabelText('Order the saved backtests'), { target: { value: 'recent' } });
    expect(within(screen.getByRole('region', { name: 'Group 80% Win' })).getAllByRole('button', { name: /^Run / })[0]).toHaveAccessibleName('Run 1h time');
  });

  it('[critical] a name already saved is said as it is typed, Save waits, and that one can be updated instead; a new one is filed in its group', async () => {
    api.saveBacktest.mockResolvedValue({ ok: true, save: save('e', 'Fresh', 9, '80% Win') });
    show();
    await screen.findByRole('region', { name: 'Group 80% Win' });
    fireEvent.change(screen.getByLabelText('Name for the saved backtest'), { target: { value: '  1H   TIME ' } });
    expect(screen.getByRole('alert')).toHaveTextContent('There is a saved backtest called "1H TIME" already');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Update “1h time” to these settings instead' }));
    await waitFor(() => expect(api.saveBacktest).toHaveBeenCalledWith({ id: 'b', name: '1h time', query: q(9) }));
    fireEvent.change(screen.getByLabelText('Name for the saved backtest'), { target: { value: 'Fresh' } });
    fireEvent.change(screen.getByLabelText('Group for the saved backtest'), { target: { value: ' 80% Win ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveBacktest).toHaveBeenLastCalledWith({ name: 'Fresh', group: '80% Win', query: q(9) }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved as "Fresh" in 80% Win.');
  });

  it('[critical] cloned: a copy under a free name, straight into its edit -- its settings on the screen; the edit moves it to another group', async () => {
    const onLoad = vi.fn();
    const copy = save('a2', '15m time copy', 1, '80% Win');
    api.cloneBacktestSave.mockImplementation(async () => { api.getBacktestSaves.mockResolvedValue({ ...LIST, saves: [...LIST.saves, copy] }); return { ok: true, save: copy }; });
    api.saveBacktest.mockResolvedValue({ ok: true, save: save('a2', '15m time copy', 1, '75% Win') });
    show({ onLoad, current: q(1) });
    fireEvent.click(await screen.findByRole('button', { name: 'Clone 15m time' }));
    await waitFor(() => expect(api.cloneBacktestSave).toHaveBeenCalledWith('a'));
    const form = await screen.findByRole('form', { name: 'Edit 15m time copy' });
    expect(onLoad).toHaveBeenLastCalledWith(q(1));
    expect(within(form).getByLabelText('Name of the saved backtest')).toHaveValue('15m time copy');
    expect(within(form).getByLabelText('Group of the saved backtest')).toHaveValue('80% Win');
    // the group alone changed is a change
    fireEvent.change(within(form).getByLabelText('Group of the saved backtest'), { target: { value: '75% Win' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.saveBacktest).toHaveBeenCalledWith({ id: 'a2', name: '15m time copy', group: '75% Win', query: q(1) }));
  });

  it('a group renamed in place, every one in it with it; a delete is asked first', async () => {
    api.renameBacktestGroup.mockResolvedValue({ ok: true, moved: 2 });
    api.deleteBacktestSave.mockResolvedValue({ ok: true, portfoliosDeleted: [] });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Rename the group 80% Win' }));
    const form = screen.getByRole('form', { name: 'Rename the group 80% Win' });
    fireEvent.change(within(form).getByLabelText('New name of the group'), { target: { value: 'High win' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(api.renameBacktestGroup).toHaveBeenCalledWith('80% Win', 'High win'));
    expect(await screen.findByRole('status')).toHaveTextContent('Renamed the group "80% Win" to "High win" (2 saved backtests).');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Loose one' }));
    expect(api.deleteBacktestSave).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('group', { name: 'Delete Loose one?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteBacktestSave).toHaveBeenCalledWith('d'));
  });

  it('[critical] portfolios: what is in each as chips; cloned into its edit; a name taken is said; a group ticked whole; a delete asked first', async () => {
    const copy = { id: 'p2', name: 'High win copy', saveIds: ['a', 'b'], createdAt: 1, updatedAt: NOW };
    api.clonePortfolio.mockImplementation(async () => { api.getBacktestSaves.mockResolvedValue({ ...LIST, portfolios: [...LIST.portfolios, copy] }); return { ok: true, portfolio: copy }; });
    api.deletePortfolio.mockResolvedValue({ ok: true });
    show({ mode: 'portfolio' });
    expect(await screen.findByRole('list', { name: 'In High win' })).toHaveTextContent('15m time1h time');
    expect(screen.getByText(/2 saved backtests · changed 2 days ago/)).toBeInTheDocument();
    // a group ticked whole
    fireEvent.click(screen.getByRole('button', { name: 'Tick every one in 80% Win' }));
    expect(screen.getByRole('checkbox', { name: 'Run 15m time together with others' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Run 1h time together with others' })).toBeChecked();
    // the same name as a portfolio already kept
    fireEvent.change(screen.getByLabelText('Name for the portfolio'), { target: { value: 'high WIN' } });
    expect(screen.getByRole('alert')).toHaveTextContent('There is a portfolio called "high WIN" already.');
    expect(screen.getByRole('button', { name: 'Keep' })).toBeDisabled();
    // cloned: into its edit
    fireEvent.click(screen.getByRole('button', { name: 'Clone the portfolio High win' }));
    await waitFor(() => expect(api.clonePortfolio).toHaveBeenCalledWith('p'));
    expect(await screen.findByRole('form', { name: 'Edit the portfolio High win copy' })).toBeInTheDocument();
    // deleted only when asked twice
    fireEvent.click(screen.getByRole('button', { name: 'Delete the portfolio High win' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Delete the portfolio High win?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deletePortfolio).toHaveBeenCalledWith('p'));
  });

  it('when it was changed, as people say it', () => {
    expect(agoWords(NOW - 10_000, NOW)).toBe('just now');
    expect(agoWords(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
    expect(agoWords(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(agoWords(NOW - 86_400_000, NOW)).toBe('1 day ago');
  });
});
