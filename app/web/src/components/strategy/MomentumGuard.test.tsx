import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MomentumGuard } from '@/components/strategy/MomentumGuard';

/** The momentum guard on the strategies card (30 Oct 2026): on or off and its points, this account's, with the rise now. */
describe('the momentum guard', () => {
  const rising = { perp: 78_360, hourAgo: 77_643, rise: 717 };

  it('[critical] off to begin with; on, the pill says the rise now and whether a call would be sold', () => {
    const { rerender } = render(<MomentumGuard guard={{ on: false, pts: 250 }} now={rising} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Momentum guard/ })).toHaveTextContent('Momentum guardoff');
    rerender(<MomentumGuard guard={{ on: true, pts: 250 }} now={rising} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Momentum guard/ })).toHaveTextContent('+250/1h · BTC +717 · CE blocked');
    rerender(<MomentumGuard guard={{ on: true, pts: 250 }} now={{ perp: 78_224, hourAgo: 78_125, rise: 99 }} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Momentum guard/ })).toHaveTextContent('BTC +99 · CE allowed');
    rerender(<MomentumGuard guard={{ on: true, pts: 250 }} now={null} onSave={async () => true} />);
    expect(screen.getByRole('button', { name: /Momentum guard/ })).toHaveTextContent('rise unknown');
  });

  it('[critical] switched on and saved with its points; points out of range are refused before they are sent', async () => {
    const onSave = vi.fn(async () => true);
    render(<MomentumGuard guard={{ on: false, pts: 250 }} now={rising} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Momentum guard/ }));
    expect(screen.getByLabelText('Now')).toHaveTextContent('BTC 78,360 · an hour ago 77,643 · +717 in 1h');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'On' }));
    fireEvent.change(screen.getByLabelText('Rise in the last hour, points'), { target: { value: '10' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Whole points from 50 to 2000.');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Rise in the last hour, points'), { target: { value: '300' } });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ on: true, pts: 300 }));
  });

  it('"Defaults" puts it back off (null)', async () => {
    const onSave = vi.fn(async () => true);
    render(<MomentumGuard guard={{ on: true, pts: 300 }} now={null} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Momentum guard/ }));
    expect(screen.getByLabelText('Now')).toHaveTextContent('cannot be read just now');
    fireEvent.click(screen.getByRole('button', { name: 'Defaults' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });
});
