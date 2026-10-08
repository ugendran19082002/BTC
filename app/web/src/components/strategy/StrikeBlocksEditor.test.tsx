import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { StrikeBlocksEditor } from '@/components/strategy/StrikeBlocksEditor';
import type { SetField } from '@/components/strategy/form-parts';
import { DEFAULT_CONFIG, DEFAULT_SIGNAL_RULE, type StrategyConfig, type StrikeBlock } from '@/types/strategy';

/**
 * "Apply to all blocks" in the strategy form (owner, 8 Oct 2026): one block's premium and its "if none", onto
 * every block of the day at a click -- said back, and undone at another.
 */

const block = (at: string, usd: number, fallbackUsd: number | null = null): StrikeBlock =>
  ({ at, strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atLeast', usd, fallbackUsd } });
const START: StrategyConfig = {
  ...DEFAULT_CONFIG, trigger: 'signal', signal: { ...DEFAULT_SIGNAL_RULE, methods: ['breakout'] }, liveOrders: false,
  entryTime: '17:35', exitTime: '17:29', strikeRule: 'premium', premium: { mode: 'atMost', usd: 50, fallbackUsd: 60 },
  strikeBlocks: [block('21:35', 30, 20), block('01:35', 15)],
};
let latest: StrategyConfig = START;
function Form({ start = START, spot }: { start?: StrategyConfig; spot?: number }) {
  const [c, setC] = useState(start);
  latest = c;
  const set: SetField = (k, v) => setC((p) => ({ ...p, [k]: v }));
  return <StrikeBlocksEditor c={c} set={set} err={() => null} spot={spot} />;
}
const usd = (n: number) => (screen.getByLabelText(`block ${n} premium usd`) as HTMLInputElement).value;
const ifNone = (n: number) => (screen.getByLabelText(`block ${n} fallback usd`) as HTMLInputElement).value;
const sign = (n: number) => screen.getByRole('radiogroup', { name: `block ${n} premium rule` }).querySelector('[aria-checked="true"]')!.textContent;

describe('StrikeBlocksEditor: apply to all blocks', () => {
  it('[critical] one click copies a block\'s premium, its sign and its "if none" onto every block, and says so', () => {
    render(<Form />);
    expect([usd(1), usd(2), usd(3)]).toEqual(['50', '30', '15']);
    fireEvent.click(screen.getByRole('button', { name: 'apply block 1 to all 3 blocks' }));
    expect([usd(1), usd(2), usd(3)]).toEqual(['50', '50', '50']);
    expect([ifNone(1), ifNone(2), ifNone(3)]).toEqual(['60', '60', '60']);
    expect(sign(2)).toBe(sign(1));
    expect(sign(3)).toBe(sign(1));
    expect(screen.getByRole('status')).toHaveTextContent('Block 1\'s rule, ≤ $50 (if none, ≤ $60), is now on all 3 blocks. Each block kept its own time and distance rule.');
    // said in the block that was clicked, where the eye already is
    expect(screen.getByRole('listitem', { name: 'block 1' })).toContainElement(screen.getByRole('status'));
    // each block is still at its own time
    expect(screen.getByRole('listitem', { name: 'block 2' })).toHaveTextContent(/9:35 PM/);
  });

  it('from any block, not only the first: block 3\'s number with no "if none" clears the others\' second number', () => {
    render(<Form />);
    fireEvent.click(screen.getByRole('button', { name: 'apply block 3 to all 3 blocks' }));
    expect([usd(1), usd(2), usd(3)]).toEqual(['15', '15', '15']);
    expect([ifNone(1), ifNone(2), ifNone(3)]).toEqual(['', '', '']);
    expect(screen.getByRole('status')).toHaveTextContent('Block 3\'s rule, ≥ $15, is now on all 3 blocks.');
    expect(screen.getByRole('listitem', { name: 'block 3' })).toContainElement(screen.getByRole('status'));
  });

  it('undo puts every block back as it was', () => {
    render(<Form />);
    fireEvent.click(screen.getByRole('button', { name: 'apply block 2 to all 3 blocks' }));
    expect([usd(1), usd(2), usd(3)]).toEqual(['30', '30', '30']);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect([usd(1), usd(2), usd(3)]).toEqual(['50', '30', '15']);
    expect([ifNone(1), ifNone(2), ifNone(3)]).toEqual(['60', '20', '']);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('an edit after the copy ends the offer to undo it: the undo would take the edit with it', () => {
    render(<Form />);
    fireEvent.click(screen.getByRole('button', { name: 'apply block 1 to all 3 blocks' }));
    fireEvent.change(screen.getByLabelText('block 2 premium usd'), { target: { value: '45' } });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect([usd(1), usd(2), usd(3)]).toEqual(['50', '45', '50']);
  });

  it('a block whose own premium is not a usable number cannot be copied; the others still can', () => {
    render(<Form start={{ ...START, strikeBlocks: [block('21:35', 0), block('01:35', 15)] }} />);
    expect(screen.getByRole('button', { name: 'apply block 2 to all 3 blocks' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'apply block 1 to all 3 blocks' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'apply block 3 to all 3 blocks' })).toBeEnabled();
  });

  it('with one rule all the time there are no blocks, and no button', () => {
    render(<Form start={{ ...START, strikeBlocks: [] }} />);
    expect(screen.queryByRole('button', { name: /apply block/ })).toBeNull();
  });
});

/*
 * By delta and by distance (owner, 8 Oct 2026: "by premium, by strike already there; by delta, by distance --
 * user friendly"): two more ways to pick the strike, for the whole window or for a block of it.
 */
const pick = (group: string, name: string) => fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name }));
const ONE_RULE: StrategyConfig = { ...START, strikeBlocks: [] };

describe('StrikeBlocksEditor: by delta and by distance', () => {
  it('[critical] one rule all the time: "By delta" starts at 0.10, a quick pick sets the number, and the form holds what is saved', () => {
    render(<Form start={ONE_RULE} />);
    expect(within(screen.getByRole('radiogroup', { name: 'strike rule' })).getAllByRole('radio').map((r) => r.textContent))
      .toEqual(['By premium', 'By strike', 'By delta', 'By distance']);
    pick('strike rule', 'By delta');
    expect(latest.strikeRule).toBe('delta');
    expect(latest.delta).toEqual({ max: 0.1 });
    expect((screen.getByLabelText('delta') as HTMLInputElement).value).toBe('0.1');
    expect(screen.getByRole('button', { name: '0.10' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '0.07' }));
    expect(latest.delta).toEqual({ max: 0.07 });
    expect(screen.getByText(/whose delta is 0\.07 or lower/)).toBeInTheDocument();
    // The premium typed before is kept under it, for the way back.
    pick('strike rule', 'By premium');
    expect(latest.premium).toEqual(START.premium);
    expect(latest.delta).toEqual({ max: 0.07 });
  });

  it('[critical] "By distance" starts at the measured figure and says what it comes to, in percent and in points', () => {
    render(<Form start={ONE_RULE} spot={85_000} />);
    pick('strike rule', 'By distance');
    expect(latest.distance).toEqual({ pct: 0.45, scale: 'time' });
    const worked = screen.getByLabelText('distance worked out');
    expect(worked).toHaveTextContent('20 h left 2.01% (≈ 1,711 pts)');
    expect(worked).toHaveTextContent('2 h left 0.64% (≈ 541 pts)');
    // Fixed reads the number another way, so it starts from its own usual figure, not from 0.45.
    pick('distance kind', 'Fixed all day');
    expect(latest.distance).toEqual({ pct: 1.5, scale: 'fixed' });
    expect(screen.getByLabelText('distance worked out')).toHaveTextContent('at least 1.50% (≈ 1,275 pts) away, at every hour');
    fireEvent.change(screen.getByLabelText('distance percent'), { target: { value: '2' } });
    expect(latest.distance).toEqual({ pct: 2, scale: 'fixed' });
  });

  it('without BTC\'s price the distance is said in percent alone', () => {
    render(<Form start={{ ...ONE_RULE, strikeRule: 'distance', distance: { pct: 0.45, scale: 'time' } }} />);
    expect(screen.getByLabelText('distance worked out')).toHaveTextContent('20 h left 2.01% · 12 h left 1.56%');
  });

  it('[critical] a block by delta: its own number, and the others untouched', () => {
    render(<Form />);
    pick('block 2 strike rule', 'By delta');
    expect(latest.strikeBlocks![0]).toMatchObject({ at: '21:35', strikeRule: 'delta', delta: { max: 0.1 } });
    fireEvent.change(screen.getByLabelText('block 2 delta'), { target: { value: '0.15' } });
    expect(latest.strikeBlocks![0]!.delta).toEqual({ max: 0.15 });
    expect(latest.strikeRule).toBe('premium');
    expect(latest.strikeBlocks![1]!.strikeRule).toBe('premium');
    expect(latest.delta).toBeUndefined();
  });

  it('[critical] a block by distance says what it asks for over that block\'s own hours', () => {
    render(<Form spot={85_000} />);
    pick('block 2 strike rule', 'By distance');
    expect(latest.strikeBlocks![0]!.distance).toEqual({ pct: 0.45, scale: 'time' });
    // Block 2 runs 9:35 PM to 1:35 AM: 19 h 55 min left at its start, 15 h 55 min at its end.
    expect(screen.getByLabelText('block 2 distance worked out')).toHaveTextContent('From BTC: 2.01% (≈ 1,707 pts) at 9:35 PM, down to 1.80% (≈ 1,526 pts) by 1:35 AM.');
    pick('block 2 distance kind', 'Fixed');
    expect(latest.strikeBlocks![0]!.distance).toEqual({ pct: 1.5, scale: 'fixed' });
    expect(screen.getByLabelText('block 2 distance worked out')).toHaveTextContent('at least 1.50% (≈ 1,275 pts) away, all block');
  });

  it('[critical] block 1 by delta is the strategy\'s own rule, and "Apply to all blocks" puts it on every block -- with the way back', () => {
    render(<Form />);
    pick('block 1 strike rule', 'By delta');
    fireEvent.change(screen.getByLabelText('block 1 delta'), { target: { value: '0.07' } });
    expect([latest.strikeRule, latest.delta]).toEqual(['delta', { max: 0.07 }]);
    fireEvent.click(screen.getByRole('button', { name: 'apply block 1 to all 3 blocks' }));
    expect(latest.strikeBlocks!.map((b) => [b.strikeRule, b.delta])).toEqual([['delta', { max: 0.07 }], ['delta', { max: 0.07 }]]);
    expect(screen.getByRole('status')).toHaveTextContent('Block 1\'s rule, delta ≤ 0.07, is now on all 3 blocks. Each block kept its own time.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(latest.strikeBlocks!.map((b) => b.strikeRule)).toEqual(['premium', 'premium']);
    expect(latest.strikeRule).toBe('delta');
  });

  it('a delta that cannot be saved greys "Apply to all blocks" on its block', () => {
    render(<Form start={{ ...START, strikeBlocks: [{ ...block('21:35', 30), strikeRule: 'delta', delta: { max: 0.9 } }, block('01:35', 15)] }} />);
    expect(screen.getByRole('button', { name: 'apply block 2 to all 3 blocks' })).toBeDisabled();
    expect(screen.getByRole('listitem', { name: 'block 2' })).toHaveTextContent('Block 2: Delta must be between 0.01 and 0.50.');
  });
});
