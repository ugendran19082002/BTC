import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MomentumGuard, guardVerdict } from '@/components/strategy/MomentumGuard';
import { ENTRY_GUARDS_TESTED } from '@/types/strategy';

/** What a save sends for guards an older server never had: calls only, the rest off at their defaults. */
const REST = { sides: 'ce', q15: { on: false, pct: 0.4 }, iv: { on: false, pts: 5 }, bid: { on: false, min: 500 } } as const;
const pill = () => screen.getByRole('button', { name: /Entry guards/ });

/** The entry guards on the strategies card: momentum (30 Oct 2026), IV spike and thin bid (21 Nov 2026), each its own switch. */
describe('the entry guards', () => {
  const rising = { perp: 78_360, hourAgo: 77_643, rise: 717 };

  it('[critical] off to begin with; momentum on, the pill says the level and whether a call or a put would be sold', () => {
    const { rerender } = render(<MomentumGuard guard={{ on: false, pts: 250 }} now={rising} onSave={async () => true} />);
    expect(pill()).toHaveTextContent('Entry guardsoff');
    rerender(<MomentumGuard guard={{ on: true, pts: 250 }} now={rising} onSave={async () => true} />);
    expect(pill()).toHaveTextContent('Momentum +250 · CE blocked · PE allowed');
    rerender(<MomentumGuard guard={{ on: true, pts: 250 }} now={{ perp: 78_224, hourAgo: 78_125, rise: 99 }} onSave={async () => true} />);
    expect(pill()).toHaveTextContent('CE allowed · PE allowed');
    rerender(<MomentumGuard guard={{ on: true, pts: 250 }} now={null} onSave={async () => true} />);
    expect(pill()).toHaveTextContent('move unknown');
  });

  it('[critical] momentum switched on and saved with its points, the other guards as they were; points out of range are refused before they are sent', async () => {
    const onSave = vi.fn(async () => true);
    render(<MomentumGuard guard={{ on: false, pts: 250 }} now={rising} onSave={onSave} />);
    fireEvent.click(pill());
    expect(screen.getByLabelText('Now')).toHaveTextContent('BTC 78,360 · an hour ago 77,643 · +717 in 1h');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Momentum guard on' }));
    fireEvent.change(screen.getByLabelText('Move in the last hour, points'), { target: { value: '10' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Whole points from 50 to 2000.');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Move in the last hour, points'), { target: { value: '300' } });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ on: true, pts: 300, unit: 'pts', pct: 0.25, ...REST }));
  });

  it('[critical] a per cent of BTC (14 Nov 2026): shown in points at BTC now, saved with its unit; the pill says it', async () => {
    const onSave = vi.fn(async () => true);
    const at67k = { perp: 67_600, hourAgo: 67_400, rise: 200 };
    const { rerender } = render(<MomentumGuard guard={{ on: true, pts: 200, unit: 'pts', pct: 0.25 }} now={at67k} onSave={onSave} />);
    expect(pill()).toHaveTextContent('Momentum +200 · CE blocked');
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('radio', { name: '% of BTC price' }));
    expect(screen.getByLabelText('Move in the last hour, per cent of BTC')).toHaveValue('0.25');
    expect(screen.getByLabelText('In points now')).toHaveTextContent('= 169 pts at BTC 67,600');
    fireEvent.change(screen.getByLabelText('Move in the last hour, per cent of BTC'), { target: { value: '0.255' } });
    expect(screen.getByRole('alert')).toHaveTextContent('A per cent from 0.05 to 2, two decimals at most.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Move in the last hour, per cent of BTC'), { target: { value: '0.25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ on: true, pts: 200, unit: 'pct', pct: 0.25, ...REST }));
    rerender(<MomentumGuard guard={{ on: true, pts: 200, unit: 'pct', pct: 0.25 }} now={{ perp: 100_000, hourAgo: 99_800, rise: 200 }} onSave={onSave} />);
    expect(pill()).toHaveTextContent('Momentum +0.25% · CE allowed');
  });

  it('[critical] "Fill in the tested set" fills every guard for a look -- nothing saved until Save, then all of it', async () => {
    const onSave = vi.fn(async () => true);
    render(<MomentumGuard guard={{ on: false, pts: 250 }} now={rising} onSave={onSave} />);
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('button', { name: 'Fill in the tested set' }));
    expect(onSave).not.toHaveBeenCalled();
    for (const name of ['Momentum guard on', 'IV spike guard on', 'Thin-bid guard on', 'Also the last 15 minutes']) expect(screen.getByRole('checkbox', { name })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'CE and PE (CE after a rise, PE after a fall)' })).toBeChecked();
    expect(screen.getByLabelText('Move in the last hour, per cent of BTC')).toHaveValue('0.8');
    expect(screen.getByLabelText('ATM IV rise in the last hour, vol points')).toHaveValue('5');
    expect(screen.getByLabelText('Least contracts bid on the strike')).toHaveValue('500');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ...ENTRY_GUARDS_TESTED, pts: 250 }));
  });

  it('[critical] one at a time: IV alone, then the thin bid alone -- each checked, each saved without the momentum guard', async () => {
    const onSave = vi.fn(async () => true);
    render(<MomentumGuard guard={{ on: false, pts: 250 }} now={rising} ivNow={{ iv: 0.462, hourAgo: 0.40 }} onSave={onSave} />);
    fireEvent.click(pill());
    expect(screen.getByLabelText('IV now')).toHaveTextContent('ATM IV 46.2% · an hour ago 40.0% · +6.2 pts');
    fireEvent.click(screen.getByRole('checkbox', { name: 'IV spike guard on' }));
    expect(screen.getByLabelText('Verdict now')).toHaveTextContent('Now, as set here: CE blocked (IV spike) · PE blocked (IV spike)');
    fireEvent.change(screen.getByLabelText('ATM IV rise in the last hour, vol points'), { target: { value: '0.5' } });
    expect(screen.getByRole('alert')).toHaveTextContent('IV: vol points from 1 to 30, one decimal at most.');
    fireEvent.change(screen.getByLabelText('ATM IV rise in the last hour, vol points'), { target: { value: '7' } });
    expect(screen.getByLabelText('Verdict now')).toHaveTextContent('CE allowed · PE allowed');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ on: false, pts: 250, unit: 'pts', pct: 0.25, ...REST, iv: { on: true, pts: 7 } }));

    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Thin-bid guard on' }));
    fireEvent.change(screen.getByLabelText('Least contracts bid on the strike'), { target: { value: '0' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Bid size: whole contracts from 1 to 1,00,000.');
    fireEvent.change(screen.getByLabelText('Least contracts bid on the strike'), { target: { value: '800' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ on: false, pts: 250, unit: 'pts', pct: 0.25, ...REST, bid: { on: true, min: 800 } }));
  });

  it('[critical] the pill and the verdict: both sides after a fall, the last 15 minutes, IV -- as the server reads them', () => {
    const g = { ...ENTRY_GUARDS_TESTED };
    // Down 0.9% in the hour: the put is held back by momentum, the call is sold.
    expect(guardVerdict(g, { perp: 89_190, hourAgo: 90_000, rise: -810, quarterAgo: 89_190 }, { iv: 0.4, hourAgo: 0.4 })).toEqual({ CE: null, PE: 'momentum 1h', moveKnown: true });
    // Flat hour, up 0.45% in 15 minutes: the call is held back.
    expect(guardVerdict(g, { perp: 90_405, hourAgo: 90_405, rise: 0, quarterAgo: 90_000 }, null).CE).toBe('momentum 15m');
    // Calls only: a fall holds nothing back.
    expect(guardVerdict({ ...g, sides: 'ce', iv: { on: false, pts: 5 } }, { perp: 89_190, hourAgo: 90_000, rise: -810, quarterAgo: 89_190 }, null)).toEqual({ CE: null, PE: null, moveKnown: true });
    // IV +5.0 holds both back, whatever the perp.
    expect(guardVerdict({ ...g, on: false }, null, { iv: 0.45, hourAgo: 0.40 })).toEqual({ CE: 'IV spike', PE: 'IV spike', moveKnown: false });
    render(<MomentumGuard guard={g} now={{ perp: 89_190, hourAgo: 90_000, rise: -810, quarterAgo: 89_190 }} ivNow={{ iv: 0.4, hourAgo: 0.4 }} onSave={async () => true} />);
    expect(pill()).toHaveTextContent('Momentum ±0.8% · 15m ±0.4% · IV +5 · Bid 500 · CE allowed · PE blocked');
  });

  it('"All off" puts every guard back off (null)', async () => {
    const onSave = vi.fn(async () => true);
    render(<MomentumGuard guard={{ on: false, pts: 300, iv: { on: true, pts: 5 } }} now={null} onSave={onSave} />);
    expect(pill()).toHaveTextContent('IV +5');
    fireEvent.click(pill());
    expect(screen.getByLabelText('Now')).toHaveTextContent('cannot be read just now');
    expect(within(screen.getByRole('dialog')).getByLabelText('IV now')).toHaveTextContent('cannot be read just now');
    fireEvent.click(screen.getByRole('button', { name: 'All off' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });
});
