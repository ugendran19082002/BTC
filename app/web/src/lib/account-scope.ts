/**
 * Which broker account the account-based screens are showing (owner, 5 Oct 2026): strategies, orders and
 * P&L are read for one account at a time, chosen on the tabs above them.
 *
 * One value for the page, set by the shell (App.tsx) from those tabs and read by the API calls of those
 * screens, so a screen asks for "the account being shown" without each component being handed it. Null is
 * every account -- and the answer of a server from before there were accounts.
 */
let scope: number | null = null;
/** True on the "All accounts" tab: every account is shown, and nothing can be made that has to belong to one. */
let everyAccount = false;

export const accountScope = (): number | null => scope;
export function setAccountScope(id: number | null, all = false): void { scope = id; everyAccount = all && id === null; }
/**
 * Whether a strategy can be made from the screen as it stands. A strategy belongs to one account and trades
 * on it, so it is made on that account's tab -- not on "All accounts", where it would belong to none of them.
 */
export const canMakeForAccount = (): boolean => !everyAccount;

/** The URL, asking for the account being shown when there is one. */
export const withAccount = (url: string): string =>
  scope === null ? url : `${url}${url.includes('?') ? '&' : '?'}account=${scope}`;
