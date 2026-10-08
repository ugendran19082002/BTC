import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
function Form({ start = START }: { start?: StrategyConfig }) {
  const [c, setC] = useState(start);
  const set: SetField = (k, v) => setC((p) => ({ ...p, [k]: v }));
  return <StrikeBlocksEditor c={c} set={set} err={() => null} />;
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
