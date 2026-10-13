import { usePhone } from '@/components/mobile/phone-context';
import { SignalBacktest } from '@/components/report/SignalBacktest';

/**
 * More → Backtest (owner, 13 Oct 2026): the signal history sold as options on the prices the contracts really
 * had. The backtest itself is shared with the desk's Methods screen. It has no account: it is of the signals.
 */
export function BacktestScreen() {
  const p = usePhone();
  return <SignalBacktest now={p.now} />;
}
