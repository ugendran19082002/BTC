import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

/**
 * The group's name beside a strategy's, wherever it is named (owner, 10 Oct 2026): one quiet read of the index for
 * the whole page, whatever the number of rows; nothing shown for a strategy in no group, or a trade by hand.
 */
const getGroupIndex = vi.fn();
vi.mock('@/api/strategy-groups', () => ({ getGroupIndex: (...a: unknown[]) => getGroupIndex(...a) }));
const { GroupTag } = await import('@/components/strategy/GroupTag');
const { PlacedLine } = await import('@/components/mobile/StrategyTag');
const { refreshGroupIndex, setGroupIndexForTest } = await import('@/hooks/useGroupOf');

const INDEX = {
  groups: [{ id: 'group-1', name: 'High Win%', accountId: 1, accountName: 'High Win%' }, { id: 'g-s', name: 'Scalps 5m', accountId: 2, accountName: 'Low win%' }],
  of: { 'sig-a': 'group-1', 'sig-b': 'g-s' },
};

beforeEach(() => { getGroupIndex.mockReset(); setGroupIndexForTest(null); });

describe('GroupTag', () => {
  it('[critical] the group beside the strategy, read once for every row; nothing for one in no group', async () => {
    getGroupIndex.mockResolvedValue(INDEX);
    render(<>{['sig-a', 'sig-a', 'sig-b', 'sig-none', null].map((id, i) => <GroupTag key={i} strategyId={id} />)}</>);
    await waitFor(() => expect(screen.getAllByLabelText('Group: High Win%')).toHaveLength(2));
    expect(screen.getByLabelText('Group: Scalps 5m')).toHaveAttribute('title', 'Group Scalps 5m · Low win%');
    expect(screen.getAllByLabelText(/^Group: /)).toHaveLength(3);
    expect(getGroupIndex).toHaveBeenCalledTimes(1);
  });

  it('follows a change at once when asked (a group renamed on the desk); an index that cannot be read shows no tag, says nothing', async () => {
    setGroupIndexForTest(INDEX);
    render(<GroupTag strategyId="sig-a" />);
    expect(screen.getByLabelText('Group: High Win%')).toBeInTheDocument();
    getGroupIndex.mockResolvedValue({ ...INDEX, groups: [{ ...INDEX.groups[0]!, name: 'Best' }, INDEX.groups[1]!] });
    await act(async () => { refreshGroupIndex(); });
    expect(await screen.findByLabelText('Group: Best')).toBeInTheDocument();
    getGroupIndex.mockResolvedValue(null);
    await act(async () => { refreshGroupIndex(); });
    expect(screen.getByLabelText('Group: Best')).toBeInTheDocument(); // the last known, not blanked by a failed read
  });

  it('[critical] on the phone\'s rows: the strategy\'s tag, then its group\'s; a trade by hand has neither', () => {
    setGroupIndexForTest(INDEX);
    const { rerender } = render(<PlacedLine plan={{ origin: 'strategy', strategyId: 'sig-b', strategyName: '5m time' }} rest={['#12 Breakout']} />);
    expect(screen.getByLabelText('Strategy: 5m time')).toBeInTheDocument();
    expect(screen.getByLabelText('Group: Scalps 5m')).toBeInTheDocument();
    rerender(<PlacedLine plan={{ origin: 'manual', strategyId: null, strategyName: null }} />);
    expect(screen.getByLabelText('Placed by hand')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Group: /)).toBeNull();
  });
});
