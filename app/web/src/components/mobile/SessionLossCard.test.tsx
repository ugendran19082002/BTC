import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';
import type { SessionLossView } from '@/api/desk';
import { nextSession, SessionLossCard } from '@/components/mobile/SessionLossCard';

/**
 * The session loss limit on the phone's Positions, read only (owner, 6 Nov 2026: "phone side position menu la mobile
 * friendly, user friendly view matum"). The desk's own figures of that morning: 07:00-17:29, up ₹283 of ₹1,212.
 */
const getSessionLossOf = vi.fn();
vi.mock('@/api/desk', () => ({ getSessionLossOf: (...a: unknown[]) => getSessionLossOf(...a) }));

const SETTING = { on: true, sessions: [{ from: '07:00', to: '17:29', limit: 15, unit: 'pct' as const }] };
const view = (over: Partial<SessionLossView> = {}): SessionLossView => ({
  setting: SETTING, blocked: null, hits: [], pctBase: { maxOpen: 160, perPositionUsd: null, source: null, totalUsd: null },
  now: { from: '07:00', to: '17:29', limit: 15, unit: 'pct', limitInr: 1212, lossInr: -283, hit: false, breachSince: null },
  ...over,
});
const ACCOUNTS = [{ id: 1, name: 'High' }, { id: 2, name: 'Medium' }];
// 6 Nov 2026, 08:00 IST.
const NOW = Date.parse('2026-11-06T08:00:00+05:30');
const show = (shown: number | 'all' = 1) => render(
  <PhoneContext.Provider value={{ now: NOW, trading: ACCOUNTS, shown } as unknown as PhoneData}><SessionLossCard /></PhoneContext.Provider>,
);

beforeEach(() => getSessionLossOf.mockReset());

describe('SessionLossCard', () => {
  it('[critical] one account in its session: the session, this session\'s money, the bar, and what is left before square-off', async () => {
    getSessionLossOf.mockResolvedValue(view());
    show(1);
    const row = await screen.findByLabelText('This session');
    expect(row).toHaveTextContent('07:00–17:29');
    expect(row).toHaveTextContent('+₹283');
    expect(row).toHaveTextContent('₹1,212 left');
    expect(row).toHaveTextContent('limit ₹1,212');
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
    expect(getSessionLossOf).toHaveBeenCalledWith(1);
  });

  it('[critical] losing: the loss in red, the bar filled by it, the rest left; at the limit it says so', async () => {
    getSessionLossOf.mockResolvedValue(view({ now: { ...view().now!, lossInr: 606 } }));
    const { unmount } = show(1);
    const row = await screen.findByLabelText('This session');
    expect(row).toHaveTextContent('−₹606');
    expect(row).toHaveTextContent('₹606 left');
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '50');
    unmount();
    getSessionLossOf.mockResolvedValue(view({ now: { ...view().now!, lossInr: 1250, breachSince: NOW - 5_000 } }));
    show(1);
    expect(await screen.findByText('At the limit: squaring off')).toBeInTheDocument();
  });

  it('[critical] stopped for the day: said, with why', async () => {
    getSessionLossOf.mockResolvedValue(view({ blocked: 'Session 07:00–17:29 lost ₹1,250 of ₹1,212 at 09:14.' }));
    show(1);
    expect(await screen.findByRole('alert')).toHaveTextContent('Stopped for todaySession 07:00–17:29 lost ₹1,250');
  });

  it('off, or between sessions: one quiet line', async () => {
    getSessionLossOf.mockResolvedValue(view({ setting: { ...SETTING, on: false }, now: null }));
    const { unmount } = show(1);
    expect(await screen.findByText('Off')).toBeInTheDocument();
    unmount();
    getSessionLossOf.mockResolvedValue(view({ now: null }));
    show(1);
    expect(await screen.findByText('No session now · next tomorrow 07:00')).toBeInTheDocument();
  });

  it('[critical] "All accounts": a row for each, by name', async () => {
    getSessionLossOf.mockImplementation((id: number) => Promise.resolve(view({ now: { ...view().now!, lossInr: id === 1 ? -283 : 100 } })));
    show('all');
    expect(await screen.findByLabelText('High session')).toHaveTextContent('+₹283');
    expect(await screen.findByLabelText('Medium session')).toHaveTextContent('−₹100');
  });

  it('[critical] "All accounts": two to a row, each a small tile -- name, money, the bar, what is left of the limit', async () => {
    getSessionLossOf.mockImplementation((id: number) => Promise.resolve(view({ now: { ...view().now!, lossInr: id === 1 ? -283 : 606 } })));
    const { container } = show('all');
    const high = await screen.findByLabelText('High session');
    expect(high).toHaveTextContent('High+₹283₹1,212 left of ₹1,212');
    expect(await screen.findByLabelText('Medium session')).toHaveTextContent('Medium−₹606₹606 left of ₹1,212');
    expect(container.querySelector('.grid-cols-2')).not.toBeNull();
    expect(screen.getAllByRole('meter')).toHaveLength(2);
  });

  it('"All accounts": an account stopped for the day, or off, is a tile too -- said in a word', async () => {
    getSessionLossOf.mockImplementation((id: number) => Promise.resolve(id === 1 ? view({ blocked: 'The 07:00–17:29 session lost ₹1,250.' }) : view({ setting: { ...SETTING, on: false }, now: null })));
    show('all');
    expect(await screen.findByRole('alert')).toHaveTextContent('HighStopped for today');
    expect(await screen.findByLabelText('Medium session')).toHaveTextContent('MediumOff');
  });

  it('[critical] an answer of another shape is "could not read", never a throw that blanks the screen', async () => {
    getSessionLossOf.mockResolvedValue({ ok: true } as never);
    show(1);
    expect(await screen.findByText('could not read')).toBeInTheDocument();
  });

  it('the next session: later today, else tomorrow\'s first', () => {
    const v = { setting: { on: true, sessions: [{ from: '13:00', to: '14:00', limit: 1, unit: 'inr' as const }, { from: '07:00', to: '08:00', limit: 1, unit: 'inr' as const }] } };
    expect(nextSession(v, NOW)).toBe('next 13:00');
    expect(nextSession(v, Date.parse('2026-11-06T15:00:00+05:30'))).toBe('next tomorrow 07:00');
    expect(nextSession({ setting: { on: true, sessions: [] } }, NOW)).toBeNull();
  });
});
