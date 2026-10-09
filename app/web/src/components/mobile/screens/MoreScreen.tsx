import { Activity, ArrowDownUp, Bell, Bot, Gauge, History, Landmark, LineChart, Settings } from 'lucide-react';
import { usePhone, type Sub } from '@/components/mobile/phone-context';
import { Panel, ListButton } from '@/components/mobile/parts';
import { phoneAlerts } from '@/lib/phone-alerts';
import { DeskSwitch } from '@/components/mobile/DeskSwitch';

/** More (6 Oct 2026): the screens that do not need a tab of their own, one tap each. */

const ITEMS: { sub: Sub; label: string; hint: string; icon: typeof Bell }[] = [
  { sub: 'history', label: 'Trade history', hint: 'Closed trades, filtered', icon: History },
  { sub: 'pairs', label: 'Signal history pairs', hint: 'Best and worst method + time frame', icon: ArrowDownUp },
  { sub: 'price', label: 'Price changes', hint: 'BTC now against 1m to 12h, from → now', icon: Activity },
  { sub: 'pressure', label: 'Pressure', hint: 'Option flow CE / PE, big move catch', icon: Gauge },
  { sub: 'account', label: 'Account', hint: 'Wallet, margin, each account', icon: Landmark },
  { sub: 'market', label: 'Market', hint: 'BTC perp, funding, the next expiry', icon: LineChart },
  { sub: 'strategies', label: 'Strategies', hint: 'Today\'s runs and signals', icon: Bot },
  { sub: 'alerts', label: 'Alerts', hint: 'What needs a look, Telegram\'s log', icon: Bell },
  { sub: 'settings', label: 'Status & settings', hint: 'Desk health, sign-in, build', icon: Settings },
];

export const SUB_TITLE: Record<Sub, string> = {
  history: 'Trade history', pairs: 'Signal pairs', price: 'Price change', pressure: 'Pressure', account: 'Account', market: 'Market', strategies: 'Strategies', alerts: 'Alerts', settings: 'Status',
};

export function MoreScreen() {
  const p = usePhone();
  const alerts = phoneAlerts(p.status, p.glance, p.perp).length;
  return (
    <>
      <Panel>
        <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0">
          {ITEMS.map((it) => (
            <li key={it.sub}>
              <ListButton onClick={() => p.go({ tab: 'more', sub: it.sub })} label={it.label}>
                <span className="flex items-center gap-3">
                  <it.icon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block text-[15px] font-medium">
                      {it.label}
                      {it.sub === 'alerts' && alerts > 0 && <span className="ml-2 rounded-full bg-[var(--down)] px-1.5 text-[11px] font-semibold text-white">{alerts}</span>}
                    </span>
                    <span className="line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">{it.hint}</span>
                  </span>
                </span>
              </ListButton>
            </li>
          ))}
        </ul>
      </Panel>
      <DeskSwitch />
    </>
  );
}
