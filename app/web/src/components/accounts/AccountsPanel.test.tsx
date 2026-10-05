import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AccountsPanel } from '@/components/accounts/AccountsPanel';
import type { AccountsAnswer, BrokerAccount } from '@/api/accounts';

const api = {
  getAccounts: vi.fn(), addAccount: vi.fn(), renameAccount: vi.fn(), testAccount: vi.fn(),
  setAccountActive: vi.fn(), makeAccountDefault: vi.fn(), removeAccount: vi.fn(),
};
vi.mock('@/api/accounts', () => ({
  getAccounts: (...a: unknown[]) => api.getAccounts(...a),
  addAccount: (...a: unknown[]) => api.addAccount(...a),
  renameAccount: (...a: unknown[]) => api.renameAccount(...a),
  testAccount: (...a: unknown[]) => api.testAccount(...a),
  setAccountActive: (...a: unknown[]) => api.setAccountActive(...a),
  makeAccountDefault: (...a: unknown[]) => api.makeAccountDefault(...a),
  removeAccount: (...a: unknown[]) => api.removeAccount(...a),
}));

const account = (o: Partial<BrokerAccount> = {}): BrokerAccount => ({
  id: 1, name: 'Main', description: 'the big one', broker: 'delta-india', keyHint: '9999', active: true, isDefault: true,
  readable: true, createdAt: 0, updatedAt: 0, lastTest: null, ...o,
});
const second = account({ id: 2, name: 'Second', description: '', keyHint: '4242', isDefault: false });
const answer = (accounts: BrokerAccount[], o: Partial<AccountsAnswer> = {}): AccountsAnswer => ({ accounts, max: 5, canStore: true, mode: 'paper', ...o });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.getAccounts.mockResolvedValue(answer([account(), second]));
});
const row = async (name: string) => within(await screen.findByRole('listitem', { name }));

describe('the broker accounts', () => {
  it('[critical] lists each account with its default mark, the key\'s last four and its last test -- and never a key', async () => {
    api.getAccounts.mockResolvedValue(answer([
      account({ lastTest: { at: Date.now(), ok: true, detail: 'Connected. Wallet balance $12.34.' } }),
      { ...second, active: false, lastTest: { at: Date.now(), ok: false, detail: 'The API secret does not match the key. (Signature Mismatch)' } },
    ]));
    render(<AccountsPanel />);
    const main = await row('Main');
    expect(main.getByText('Default · the desk trades on this')).toBeInTheDocument();
    expect(main.getByText('••••9999')).toBeInTheDocument();
    expect(main.getByLabelText('last connection test')).toHaveTextContent('✓ Connected. Wallet balance $12.34. · tested just now');
    expect(main.queryByRole('button', { name: 'Make default' })).toBeNull(); // it already is
    const other = await row('Second');
    expect(other.getByText('Off')).toBeInTheDocument();
    expect(other.getByLabelText('last connection test')).toHaveTextContent('✗ The API secret does not match the key.');
    expect(other.getByRole('button', { name: 'Make default' })).toBeDisabled(); // off: switch it on first
    expect(other.getByRole('button', { name: 'Activate' })).toBeEnabled();
    expect(screen.getByLabelText('broker accounts')).toHaveTextContent('2 of 5 · desk is on paper');
  });

  it('[critical] adding an account sends the key once and forgets it; a refusal is said and the form kept', async () => {
    render(<AccountsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
    const form = within(screen.getByRole('form', { name: 'add an account' }));
    expect(form.getByRole('button', { name: 'Save account' })).toBeDisabled(); // nothing typed
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Third' } });
    fireEvent.change(form.getByLabelText('API key'), { target: { value: 'the-key' } });
    const secret = form.getByLabelText('API secret');
    expect(secret).toHaveAttribute('type', 'password');
    fireEvent.change(secret, { target: { value: 'the-secret' } });

    api.addAccount.mockRejectedValueOnce(new Error('That does not look like an API key.'));
    fireEvent.click(form.getByRole('button', { name: 'Save account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That does not look like an API key.');
    expect(form.getByLabelText('Name')).toHaveValue('Third'); // nothing typed is lost

    const third = account({ id: 3, name: 'Third', keyHint: '-key', isDefault: false, lastTest: { at: Date.now(), ok: true, detail: 'Connected.' } });
    api.addAccount.mockResolvedValueOnce(answer([account(), second, third]));
    fireEvent.click(form.getByRole('button', { name: 'Save account' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved "Third". Connected.');
    expect(api.addAccount).toHaveBeenLastCalledWith({ name: 'Third', description: '', apiKey: 'the-key', apiSecret: 'the-secret' });
    expect(screen.queryByRole('form', { name: 'add an account' })).toBeNull();
    expect(document.body.innerHTML).not.toContain('the-secret');
    await row('Third');
  });

  it('[critical] choosing a default on a live desk asks first; on paper it is one tap', async () => {
    api.getAccounts.mockResolvedValue(answer([account(), second], { mode: 'live' }));
    api.makeAccountDefault.mockResolvedValue(answer([account({ isDefault: false }), { ...second, isDefault: true }], { mode: 'live' }));
    const { unmount } = render(<AccountsPanel />);
    fireEvent.click((await row('Second')).getByRole('button', { name: 'Make default' }));
    expect(api.makeAccountDefault).not.toHaveBeenCalled();
    const asked = within(screen.getByRole('group', { name: 'trade on Second?' }));
    expect(asked.getByText('The desk is LIVE. From this tap, real orders go to "Second".')).toBeInTheDocument();
    fireEvent.click(asked.getByRole('button', { name: 'Yes, trade on it' }));
    await waitFor(() => expect(api.makeAccountDefault).toHaveBeenCalledWith(2));
    expect(await (await row('Second')).findByText('Default · the desk trades on this')).toBeInTheDocument();
    expect((await row('Second')).getByRole('status')).toHaveTextContent('The desk now trades on "Second".');
    unmount();

    api.getAccounts.mockResolvedValue(answer([account(), second]));
    api.makeAccountDefault.mockClear();
    api.makeAccountDefault.mockRejectedValue(new Error('Not made the default: its connection test failed. Delta does not know this API key. (invalid_api_key)'));
    render(<AccountsPanel />);
    fireEvent.click((await row('Second')).getByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(api.makeAccountDefault).toHaveBeenCalledWith(2));
    expect(await (await row('Second')).findByRole('alert')).toHaveTextContent('Not made the default: its connection test failed.');
  });

  it('[critical] removing asks twice, and the server\'s refusal is said beside the account', async () => {
    api.getAccounts.mockResolvedValue(answer([account(), second], { mode: 'live' }));
    render(<AccountsPanel />);
    fireEvent.click((await row('Main')).getByRole('button', { name: 'Remove' }));
    expect(api.removeAccount).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('group', { name: 'remove Main?' })).getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('group', { name: 'remove Main?' })).toBeNull();

    api.removeAccount.mockRejectedValueOnce(new Error('The desk is trading live on this account. Switch to paper first.'));
    fireEvent.click((await row('Main')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'remove Main?' })).getByRole('button', { name: 'Yes, remove' }));
    expect(await (await row('Main')).findByRole('alert')).toHaveTextContent('The desk is trading live on this account. Switch to paper first.');

    api.removeAccount.mockResolvedValueOnce(answer([account()], { mode: 'live' }));
    fireEvent.click((await row('Second')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'remove Second?' })).getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Second' })).toBeNull());
    expect(api.removeAccount).toHaveBeenLastCalledWith(2);
  });

  it('test, deactivate and edit the name; an unreadable key can only be removed; a full list and a server that cannot encrypt say so', async () => {
    const { unmount } = render(<AccountsPanel />);
    api.testAccount.mockResolvedValue(answer([account({ lastTest: { at: Date.now(), ok: true, detail: 'Connected.' } }), second], { test: { id: 1, ok: true, detail: 'Connected.' } }));
    fireEvent.click((await row('Main')).getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect((screen.getByRole('listitem', { name: 'Main' }))).toHaveTextContent('✓ Connected. · tested just now'));

    api.setAccountActive.mockResolvedValue(answer([account(), { ...second, active: false }]));
    fireEvent.click((await row('Second')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(api.setAccountActive).toHaveBeenCalledWith(2, false));
    expect(await (await row('Second')).findByRole('status')).toHaveTextContent('Switched off. It is kept, and not used.');

    api.renameAccount.mockResolvedValue(answer([account(), { ...second, name: 'Hedge', active: false }]));
    fireEvent.click((await row('Second')).getByRole('button', { name: 'Edit name' }));
    const edit = within(screen.getByRole('form', { name: 'edit Second' }));
    fireEvent.change(edit.getByLabelText('Name'), { target: { value: 'Hedge' } });
    fireEvent.click(edit.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.renameAccount).toHaveBeenCalledWith(2, { name: 'Hedge', description: '' }));
    await row('Hedge');
    unmount();

    api.getAccounts.mockResolvedValue(answer([account({ readable: false, isDefault: false })], { max: 1, canStore: false }));
    render(<AccountsPanel />);
    const broken = await row('Main');
    expect(broken.getByText('Key unreadable')).toBeInTheDocument();
    expect(broken.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(broken.getByRole('button', { name: 'Make default' })).toBeDisabled();
    expect(broken.getByRole('button', { name: 'Remove' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add account' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('The server has no DESK_SESSION_SECRET');
  });
});
