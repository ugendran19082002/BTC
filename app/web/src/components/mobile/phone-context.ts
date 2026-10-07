import { createContext, useContext } from 'react';
import type { BrokerAccount } from '@/api/accounts';
import type { Glance } from '@/api/glance';
import type { Me } from '@/api/session';
import type { TradeStatus } from '@/types/trade';

/**
 * What every phone screen shares (6 Oct 2026): the desk's status and health, read once by the shell and handed
 * down, the account being shown, the clock, and how to move -- so five screens do not poll the same thing five
 * times.
 */

export type Tab = 'home' | 'pnl' | 'positions' | 'orders' | 'more';
export type Sub = 'history' | 'pairs' | 'price' | 'pressure' | 'account' | 'market' | 'strategies' | 'alerts' | 'settings';
export type Route = { tab: Tab; sub: Sub | null; trade: string | null };

export const TABS: readonly Tab[] = ['home', 'pnl', 'positions', 'orders', 'more'];
export const SUBS: readonly Sub[] = ['history', 'pairs', 'price', 'pressure', 'account', 'market', 'strategies', 'alerts', 'settings'];

/** The route in a URL's query: `?tab=orders`, `?tab=more&sub=account`, `?trade=<id>` (the Telegram link). */
export function routeOf(search: string): Route {
  const q = new URLSearchParams(search);
  const tab = (TABS as readonly string[]).includes(q.get('tab') ?? '') ? (q.get('tab') as Tab) : 'home';
  const sub = tab === 'more' && (SUBS as readonly string[]).includes(q.get('sub') ?? '') ? (q.get('sub') as Sub) : null;
  const trade = q.get('trade')?.trim() || null;
  return { tab, sub, trade };
}

export function searchOf(r: Route): string {
  const q = new URLSearchParams();
  if (r.tab !== 'home') q.set('tab', r.tab);
  if (r.sub) q.set('sub', r.sub);
  if (r.trade) q.set('trade', r.trade);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export type PhoneData = {
  me: Me;
  status: TradeStatus | null;
  statusError: Error | null;
  statusAt: number | null;
  glance: Glance | null;
  glanceError: Error | null;
  /** The trading accounts, and the one shown: an id, or every account. */
  accounts: BrokerAccount[];
  trading: BrokerAccount[];
  shown: number | 'all';
  /** The account to ask the server for: null is every account. */
  accountParam: number | null;
  now: number;
  /** The BTC perp now: its last trade as it prints (the stream), else the mark the glance read. `perpLive`: printing. */
  perp: number | null;
  perpLive: boolean;
  go: (to: Partial<Route>) => void;
  openTrade: (tradeId: string) => void;
  signOut: () => void;
  onSignedOut: () => void;
};

export const PhoneContext = createContext<PhoneData | null>(null);

export function usePhone(): PhoneData {
  const v = useContext(PhoneContext);
  if (!v) throw new Error('usePhone outside the phone shell');
  return v;
}
