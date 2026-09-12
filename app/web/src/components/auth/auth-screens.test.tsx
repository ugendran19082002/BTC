import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AuthError } from '@/api/session';

const api = vi.hoisted(() => ({
  login: vi.fn(), submitCode: vi.fn(), getSetup: vi.fn(), enableTwoStep: vi.fn(),
  getAccount: vi.fn(), changePassword: vi.fn(), newRecoveryCodes: vi.fn(), signOutOthers: vi.fn(), logout: vi.fn(),
}));
vi.mock('@/api/session', async (orig) => ({ ...(await orig<typeof import('@/api/session')>()), ...api }));

const { LoginPage } = await import('@/components/desk/LoginPage');
const { TwoStepSetup } = await import('@/components/auth/TwoStepSetup');
const { ChangePasswordForm } = await import('@/components/auth/ChangePasswordForm');
const { ProfileMenu } = await import('@/components/auth/ProfileMenu');

/**
 * Signing in on the screen: password, then the authenticator code; the
 * first-time setup; and changing the password from the profile.
 */

/*
 * The account sheet remembers which of its sections were left open, in
 * localStorage. Without clearing it one test's click decides where the next one
 * starts, and a click meant to open a section closes it instead.
 */
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('sign in: password, then the code', () => {
  const show = () => {
    const onSignedIn = vi.fn();
    const onNeedsSetup = vi.fn();
    render(<LoginPage onSignedIn={onSignedIn} onNeedsSetup={onNeedsSetup} />);
    return { onSignedIn, onNeedsSetup };
  };
  const password = async () => {
    type(/Username/, 'ugendran');
    type(/Password/, 'a long private passphrase');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  };

  it('[critical] a right password does not open the desk: it asks for the authenticator code', async () => {
    api.login.mockResolvedValue({ ok: true, next: 'code' });
    const { onSignedIn } = show();
    await password();
    expect(await screen.findByText(/Enter authenticator code/i)).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(api.login).toHaveBeenCalledWith('ugendran', 'a long private passphrase');
  });

  it('[critical] six digits sign in on their own, without another tap', async () => {
    api.login.mockResolvedValue({ ok: true, next: 'code' });
    api.submitCode.mockResolvedValue({ ok: true, usedRecoveryCode: false });
    const { onSignedIn } = show();
    await password();
    const input = await screen.findByRole('textbox', { name: 'authenticator code' });
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    fireEvent.change(input, { target: { value: '482 731' } });
    await waitFor(() => expect(api.submitCode).toHaveBeenCalledWith('482731'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });

  it('a wrong code says so and clears the field, for another try', async () => {
    api.login.mockResolvedValue({ ok: true, next: 'code' });
    api.submitCode.mockRejectedValue(new AuthError('That code is not right.', 401));
    show();
    await password();
    fireEvent.change(await screen.findByRole('textbox', { name: 'authenticator code' }), { target: { value: '000000' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right.');
    expect(screen.getByRole('textbox', { name: 'authenticator code' })).toHaveValue('');
  });

  it('[critical] too many wrong codes send it back to the password', async () => {
    api.login.mockResolvedValue({ ok: true, next: 'code' });
    api.submitCode.mockRejectedValue(new AuthError('Too many wrong codes. Sign in again.', 401, [], true));
    show();
    await password();
    fireEvent.change(await screen.findByRole('textbox', { name: 'authenticator code' }), { target: { value: '000000' } });
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Too many wrong codes. Sign in again.');
  });

  it('a recovery code can be used instead', async () => {
    api.login.mockResolvedValue({ ok: true, next: 'code' });
    api.submitCode.mockResolvedValue({ ok: true, usedRecoveryCode: true });
    const { onSignedIn } = show();
    await password();
    fireEvent.click(await screen.findByRole('button', { name: 'Use a recovery code' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'recovery code' }), { target: { value: 'k7pq-m2xd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(api.submitCode).toHaveBeenCalledWith('K7PQ-M2XD'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });

  it('a first sign-in goes to the security setup', async () => {
    api.login.mockResolvedValue({ ok: true, next: 'setup' });
    const { onNeedsSetup } = show();
    await password();
    await waitFor(() => expect(onNeedsSetup).toHaveBeenCalled());
  });

  it('a wrong password says only that one of the two was wrong', async () => {
    api.login.mockRejectedValue(new AuthError('Wrong username or password.', 401));
    show();
    await password();
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password.');
  });
});

describe('first-time security setup', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';

  it('[critical] QR code, then the code, then the recovery codes, and only then the desk', async () => {
    api.getSetup.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://x', qrSvg: SVG });
    api.enableTwoStep.mockResolvedValue({ ok: true, recoveryCodes: ['AAAA-BBBB', 'CCCC-DDDD', 'EEEE-FFFF', 'GGGG-HHHH', 'JJJJ-KKKK', 'LLLL-MMMM', 'NNNN-PPPP', 'QQQQ-RRRR', 'SSSS-TTTT', 'UUUU-VVVV'] });
    const onDone = vi.fn();
    render(<TwoStepSetup onDone={onDone} onRestart={() => {}} />);

    const qr = await screen.findByRole('img', { name: /QR code/ });
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(screen.getByLabelText('setup key')).toHaveTextContent('JBSW Y3DP EHPK 3PXP');

    fireEvent.click(screen.getByRole('button', { name: 'I have scanned it' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'authenticator code' }), { target: { value: '482731' } });
    await waitFor(() => expect(api.enableTwoStep).toHaveBeenCalledWith('482731'));

    const list = within(await screen.findByRole('list', { name: 'recovery codes' }));
    expect(list.getAllByRole('listitem')).toHaveLength(10);
    const open = screen.getByRole('button', { name: 'Open the desk' });
    expect(open).toBeDisabled();
    fireEvent.click(open);
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /saved these recovery codes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open the desk' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('a wrong code keeps it off, and says why', async () => {
    api.getSetup.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://x', qrSvg: SVG });
    api.enableTwoStep.mockRejectedValue(new AuthError('That code is not right.', 401));
    render(<TwoStepSetup onDone={() => {}} onRestart={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'I have scanned it' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'authenticator code' }), { target: { value: '000000' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right.');
    expect(screen.queryByRole('list', { name: 'recovery codes' })).toBeNull();
  });

  it('an expired setup step goes back to sign-in', async () => {
    api.getSetup.mockRejectedValue(new AuthError('Sign in again.', 401, [], true));
    const onRestart = vi.fn();
    render(<TwoStepSetup onDone={() => {}} onRestart={onRestart} />);
    await waitFor(() => expect(onRestart).toHaveBeenCalled());
  });
});

describe('change password', () => {
  const fill = (current: string, next: string, confirm: string, code: string) => {
    type('current password', current);
    type('new password', next);
    type('confirm new password', confirm);
    fireEvent.change(screen.getByRole('textbox', { name: 'authenticator code' }), { target: { value: code } });
  };

  it('[critical] the button waits until every rule is met and there is a code', () => {
    render(<ChangePasswordForm username="ugendran" />);
    const button = screen.getByRole('button', { name: 'Change password' });
    fill('old passphrase here', 'short', 'short', '482731');
    expect(button).toBeDisabled();
    expect(within(screen.getByRole('list', { name: 'password rules' })).getByText('At least 12 characters').parentElement).not.toHaveClass('text-[var(--up)]');
    fill('old passphrase here', 'ugendran new passphrase', 'ugendran new passphrase', '482731');
    expect(button).toBeDisabled();
    fill('old passphrase here', 'a brand new passphrase', 'a brand new passphrase!', '482731');
    expect(button).toBeDisabled();
    fill('old passphrase here', 'a brand new passphrase', 'a brand new passphrase', '4827');
    expect(button).toBeDisabled();
    fill('old passphrase here', 'a brand new passphrase', 'a brand new passphrase', '482731');
    expect(button).toBeEnabled();
  });

  it('[critical] sends the current password, the new one and the code, and says what happened', async () => {
    api.changePassword.mockResolvedValue({ ok: true, endedSessions: 2 });
    const onChanged = vi.fn();
    render(<ChangePasswordForm username="ugendran" onChanged={onChanged} />);
    fill('old passphrase here', 'a brand new passphrase', 'a brand new passphrase', '482731');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith({ current: 'old passphrase here', next: 'a brand new passphrase', code: '482731' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed. 2 other devices were signed out.');
    expect(screen.getByLabelText('new password')).toHaveValue('');
    expect(onChanged).toHaveBeenCalledWith(2);
  });

  it('shows the server\'s reason when it refuses', async () => {
    api.changePassword.mockRejectedValue(new AuthError('The current password is not right.', 401));
    render(<ChangePasswordForm username="ugendran" />);
    fill('wrong old one here', 'a brand new passphrase', 'a brand new passphrase', '482731');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The current password is not right.');
  });

  it('passwords can be shown to check them', () => {
    render(<ChangePasswordForm username="ugendran" />);
    expect(screen.getByLabelText('new password')).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'show passwords' }));
    expect(screen.getByLabelText('new password')).toHaveAttribute('type', 'text');
  });
});

describe('the profile menu', () => {
  const account = {
    username: 'ugendran', passwordChangedAt: Date.UTC(2026, 8, 1), twoFactorSince: Date.UTC(2026, 8, 11), recoveryCodesLeft: 9,
    sessionExpiresAt: Date.UTC(2026, 8, 12, 9, 30),
    sessions: [
      { id: 'a', current: true, createdAt: Date.now() - 60_000, lastSeenAt: Date.now(), expiresAt: Date.now() + 1e7, ip: '152.57.92.146', device: 'Android · Chrome' },
      { id: 'b', current: false, createdAt: Date.now() - 3.6e6, lastSeenAt: Date.now() - 6e5, expiresAt: Date.now() + 1e7, ip: '10.0.0.2', device: 'Mac · Safari' },
    ],
    events: [{ id: 1, at: Date.now() - 60_000, kind: 'signin', ip: '152.57.92.146', detail: null }, { id: 2, at: Date.now() - 120_000, kind: 'code_wrong', ip: '1.2.3.4', detail: null }],
  };

  it('[critical] the profile button opens the account, with change password first', async () => {
    api.getAccount.mockResolvedValue(account);
    render(<ProfileMenu username="ugendran" onSignedOut={() => {}} />);
    expect(screen.getByRole('button', { name: 'Account' })).toHaveTextContent('u');
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(await screen.findByRole('form', { name: 'change password' })).toBeInTheDocument();
    expect(await screen.findByText(/Two-step sign-in/)).toBeInTheDocument();
  });

  it('lists the devices signed in, and signs the others out', async () => {
    api.getAccount.mockResolvedValue(account);
    api.signOutOthers.mockResolvedValue({ ok: true, ended: 1 });
    render(<ProfileMenu username="ugendran" onSignedOut={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('button', { name: /Devices signed in · 2/ }));
    const devices = within(screen.getByRole('list', { name: 'devices' }));
    expect(devices.getByText('this device')).toBeInTheDocument();
    expect(devices.getByText('Mac · Safari')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out the other 1 device' }));
    await waitFor(() => expect(api.signOutOthers).toHaveBeenCalled());
  });

  it('[critical] a long activity list scrolls inside the sheet instead of stretching it', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, at: Date.now() - i * 60_000, kind: i % 2 ? 'signin' : 'password_wrong', ip: '1.2.3.4', detail: null }));
    api.getAccount.mockResolvedValue({ ...account, events: many });
    render(<ProfileMenu username="ugendran" onSignedOut={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Recent activity' }));
    const list = screen.getByRole('list', { name: 'recent activity' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(20);
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain('max-h-56');
    expect(screen.getByText(/The 20 most recent/)).toBeInTheDocument();
  });

  it('shows recent activity, with the worrying kinds marked', async () => {
    api.getAccount.mockResolvedValue(account);
    render(<ProfileMenu username="ugendran" onSignedOut={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Recent activity' }));
    const list = within(screen.getByRole('list', { name: 'recent activity' }));
    expect(list.getByText('Signed in')).toBeInTheDocument();
    expect(list.getByText('Wrong authenticator code').className).toContain('--warn');
  });

  it('[critical] remembers which sections were left open', async () => {
    // Opening the sheet to change a password and finding all four sections back
    // the way they shipped, every time, is the page refusing to learn something
    // it already knows.
    api.getAccount.mockResolvedValue(account);
    const first = render(<ProfileMenu username="ugendran" onSignedOut={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Recent activity' }));
    expect(screen.getByRole('button', { name: 'Recent activity' })).toHaveAttribute('aria-expanded', 'true');
    first.unmount();

    render(<ProfileMenu username="ugendran" onSignedOut={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(await screen.findByRole('button', { name: 'Recent activity' }))
      .toHaveAttribute('aria-expanded', 'true');
  });

  it('[critical] sign out ends the session on the server and leaves the desk', async () => {
    api.getAccount.mockResolvedValue(account);
    api.logout.mockResolvedValue(new Response('{}'));
    const onSignedOut = vi.fn();
    render(<ProfileMenu username="ugendran" onSignedOut={onSignedOut} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(api.logout).toHaveBeenCalled());
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  });
});
