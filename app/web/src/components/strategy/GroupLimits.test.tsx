import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GroupLimits, type AccountLimits } from '@/components/strategy/GroupLimits';
import { REENTRY_DEFAULT, ZONE_FRESH_DEFAULT_S, type GroupOwn, type StrategyGroup } from '@/types/strategy';
import { groupOwnWords } from '@/lib/strategy-groups';

/**
 * A group's own limits on the desk (owner, 8 Nov 2026: "change them for each group"; "wherever they are by account, by
 * group too"). Each of the account's seven: the group's own where set, the account's where not, said beside it; saved for
 * the group alone; back to the account's in one tap.
 */
const setSignalMaxOpen = vi.fn(), setSideMax = vi.fn(), setStrikeMax = vi.fn(), setStrikeFull = vi.fn();
const setZoneFresh = vi.fn(), setMomentumGuard = vi.fn(), setReentry = vi.fn(), setCapSwap = vi.fn();
vi.mock('@/api/strategy', () => ({
  setSignalMaxOpen: (...a: unknown[]) => setSignalMaxOpen(...a), setSideMax: (...a: unknown[]) => setSideMax(...a),
  setStrikeMax: (...a: unknown[]) => setStrikeMax(...a), setStrikeFull: (...a: unknown[]) => setStrikeFull(...a),
  setZoneFresh: (...a: unknown[]) => setZoneFresh(...a), setMomentumGuard: (...a: unknown[]) => setMomentumGuard(...a),
  setReentry: (...a: unknown[]) => setReentry(...a), setCapSwap: (...a: unknown[]) => setCapSwap(...a),
}));

const NONE: GroupOwn = { maxOpen: null, ce: null, pe: null, strikeMax: null, strikeFull: null, zoneFresh: null, momentum: null, reentry: null };
const ACCOUNT: AccountLimits = {
  maxOpen: 300, side: { CE: 80, PE: 80 }, strikePct: 15, strikeFull: 'next', zoneFresh: { ...ZONE_FRESH_DEFAULT_S },
  momentum: { on: true, pts: 200 }, momentumNow: null as never, reentry: REENTRY_DEFAULT,
};
const group = (own: Partial<GroupOwn> = {}, openNow = { all: 12, CE: 5, PE: 7 }): StrategyGroup => ({
  id: 'g-scalps', name: 'Scalps', accountId: 1, accountName: 'High', createdAt: 0, updatedAt: 0, own: { ...NONE, ...own }, openNow,
});
const act = vi.fn(async (_k: string, fn: () => Promise<unknown>) => { await fn(); return true; });
const onInvalid = vi.fn();
const show = (g: StrategyGroup) => render(<GroupLimits group={g} account={ACCOUNT} busy={null} act={act} onInvalid={onInvalid} />);

beforeEach(() => { for (const f of [setSignalMaxOpen, setSideMax, setStrikeMax, setStrikeFull, setZoneFresh, setMomentumGuard, setReentry, setCapSwap, act, onInvalid]) f.mockClear(); });

describe('GroupLimits', () => {
  it('[critical] none of its own: "all the account\'s"; its own: said in short words, with what it holds of its own limit', () => {
    const { unmount } = show(group());
    expect(screen.getByText("all the account's")).toBeInTheDocument();
    unmount();
    show(group({ maxOpen: 150, ce: 60, momentum: { on: true, pts: 250 } }));
    expect(screen.getByLabelText('own limits of Scalps')).toHaveTextContent('Own: At most 150 · CE 60% · Momentum +250');
    expect(screen.getByText('12 of 150 open')).toBeInTheDocument();
  });

  it('[critical] opened: each setting says whose it is -- the group\'s own, or the account\'s', () => {
    show(group({ maxOpen: 150, ce: 60 }));
    fireEvent.click(screen.getByRole('button', { name: 'Limits of Scalps' }));
    const panel = screen.getByRole('group', { name: 'limits of Scalps' });
    expect(within(panel).getByRole('button', { name: "At most open: back to the account's" })).toHaveTextContent('own');
    expect(within(panel).getByRole('button', { name: "CE and PE max: back to the account's" })).toBeInTheDocument();
    for (const l of ['Strike max', 'Fill window', 'Momentum guard', 'Re-entry']) expect(within(panel).getByLabelText(`${l}: the account's`)).toBeInTheDocument();
    expect(within(panel).getByLabelText('At most open at once, this group')).toHaveValue('150');
  });

  it('[critical] its at most open typed is saved for the group alone; empty is back to the account\'s; above the account\'s is refused, not sent', async () => {
    show(group());
    fireEvent.click(screen.getByRole('button', { name: 'Limits of Scalps' }));
    const field = screen.getByLabelText('At most open at once, this group');
    expect(field).toHaveAttribute('placeholder', '300');
    fireEvent.change(field, { target: { value: '120' } });
    fireEvent.blur(field);
    await waitFor(() => expect(setSignalMaxOpen).toHaveBeenCalledWith(120, 'g-scalps'));
    fireEvent.change(field, { target: { value: '301' } });
    fireEvent.blur(field);
    expect(onInvalid).toHaveBeenCalledWith(expect.stringMatching(/1 to the account's 300/));
    expect(setSignalMaxOpen).toHaveBeenCalledTimes(1);
  });

  it('[critical] one tap takes a setting back to the account\'s; "All back" takes every own one back, and only those', async () => {
    show(group({ maxOpen: 150, pe: 40, strikeFull: 'skip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Limits of Scalps' }));
    fireEvent.click(screen.getByRole('button', { name: "At most open: back to the account's" }));
    await waitFor(() => expect(setSignalMaxOpen).toHaveBeenCalledWith(null, 'g-scalps'));
    fireEvent.click(screen.getByRole('button', { name: /All back to the account's/ }));
    await waitFor(() => expect(setStrikeFull).toHaveBeenCalledWith(null, 'g-scalps'));
    expect(setSideMax).toHaveBeenCalledWith('PE', null, 'g-scalps');
    expect(setSideMax).not.toHaveBeenCalledWith('CE', null, 'g-scalps');
    expect(setZoneFresh).not.toHaveBeenCalled();
  });

  it('the short words: only what the group sets', () => {
    expect(groupOwnWords(null)).toEqual([]);
    expect(groupOwnWords({ ...NONE, strikeMax: 5, strikeFull: 'skip', reentry: { ...REENTRY_DEFAULT, sl: { ...REENTRY_DEFAULT.sl, on: true } } }))
      .toEqual(['Strike 5%', 'Full: skip', 'Re-entry SL']);
  });

  it('[critical] the account\'s momentum guard in per cent reads as the account row has it, not as points (16 Nov 2026)', () => {
    render(<GroupLimits group={group()} account={{ ...ACCOUNT, momentum: { on: true, pts: 200, unit: 'pct', pct: 0.25 } }} busy={null} act={act} onInvalid={onInvalid} />);
    fireEvent.click(screen.getByRole('button', { name: 'Limits of Scalps' }));
    const pill = screen.getByRole('button', { name: /Momentum guard/ });
    expect(pill).toHaveTextContent('+0.25%/1h');
    expect(pill).not.toHaveTextContent('+200/1h');
  });

  it('[critical] swap at full cap is shown in the group\'s limits as the account\'s, and saved as the account\'s (16 Nov 2026)', async () => {
    const { rerender } = render(<GroupLimits group={group()} account={ACCOUNT} busy={null} act={act} onInvalid={onInvalid} />);
    fireEvent.click(screen.getByRole('button', { name: 'Limits of Scalps' }));
    expect(screen.queryByRole('button', { name: /Swap at full cap/ })).toBeNull();
    rerender(<GroupLimits group={group()} account={{ ...ACCOUNT, capSwap: { on: true, pct: 70, perMin: 20 } }} busy={null} act={act} onInvalid={onInvalid} />);
    expect(screen.getByRole('button', { name: /Swap at full cap/ })).toHaveTextContent('on · 70% kept · max 20/min');
    expect(screen.getByLabelText("Swap at full cap: the account's")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Swap at full cap/ }));
    fireEvent.click(screen.getByRole('button', { name: '75%' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setCapSwap).toHaveBeenCalledWith({ on: true, pct: 75, perMin: 20 }));
    expect(setCapSwap.mock.calls[0]).toHaveLength(1);
  });
});
