import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AlertSwitch } from '@/components/trade/AlertSwitch';
import type { TradeStatus } from '@/types/trade';

const setAlerts = vi.fn();
vi.mock('@/api/trade', () => ({ setAlerts: (...a: unknown[]) => setAlerts(...a) }));

/**
 * Fill alerts on or off.
 *
 * Two facts kept apart: whether Telegram is configured on the server, and
 * whether messages are wanted right now. With no bot there is no switch — a
 * control that cannot do anything is worse than no control — and the one thing
 * the switch must never suggest is that it stops the desk trading.
 */
const status = (alerts?: TradeStatus['alerts']): TradeStatus =>
  ({ mode: 'live', alerts } as unknown as TradeStatus);

beforeEach(() => {
  vi.clearAllMocks();
  setAlerts.mockResolvedValue({ ok: true, alerts: { configured: true, on: false } });
});

describe('the alert switch', () => {
  it('[critical] turns alerts off, and asks the desk to refresh', async () => {
    const onChanged = vi.fn();
    render(<AlertSwitch status={status({ configured: true, on: true })} onChanged={onChanged} />);
    const button = screen.getByRole('button', { name: /Fill alerts are on/ });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button);
    await waitFor(() => expect(setAlerts).toHaveBeenCalledWith(false));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('[critical] turns them back on from the off state', async () => {
    render(<AlertSwitch status={status({ configured: true, on: false })} />);
    const button = screen.getByRole('button', { name: /Fill alerts are off/ });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Alerts off')).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(setAlerts).toHaveBeenCalledWith(true));
  });

  it('[critical] says it silences the messages and not the desk', () => {
    render(<AlertSwitch status={status({ configured: true, on: true })} />);
    expect(screen.getByRole('button', { name: /Fill alerts are on/ }).getAttribute('title'))
      .toMatch(/the desk goes on trading, protecting and closing/);
  });

  it('[critical] no bot on the server means no switch, and it says why', () => {
    render(<AlertSwitch status={status({ configured: false, on: true })} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText(/not set up on this server/)).toBeInTheDocument();
    expect(screen.getByTitle(/Set TG_TOKEN and TG_CHAT_ID/)).toBeInTheDocument();
  });

  it('a server that predates the switch reads as on, rather than as broken', () => {
    render(<AlertSwitch status={status(undefined)} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText(/not set up on this server/)).toBeInTheDocument();
  });

  it('shows nothing at all before the desk has answered', () => {
    const { container } = render(<AlertSwitch status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('[critical] cannot be pressed twice into the same change', async () => {
    let release: (v: unknown) => void = () => {};
    setAlerts.mockReturnValue(new Promise((r) => { release = r; }));
    render(<AlertSwitch status={status({ configured: true, on: true })} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toBeDisabled();
    fireEvent.click(screen.getByRole('button'));
    expect(setAlerts).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
  });

  it('a refusal says so rather than pretending it worked', async () => {
    setAlerts.mockRejectedValue(new Error('nope'));
    render(<AlertSwitch status={status({ configured: true, on: true })} />);
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Try again')).toBeInTheDocument();
  });
});
