import { usePhone } from '@/components/mobile/phone-context';
import { MarketReport } from '@/components/report/MarketReport';

/**
 * More → Market report (owner, 13 Oct 2026): every expiry day's kind of market and what the signal history and
 * the real orders made on it. The report itself is shared with the desk's Methods screen; here it is read for the
 * account the phone is showing -- every account's orders on "All accounts".
 */
export function MarketReportScreen() {
  const p = usePhone();
  return <MarketReport account={p.accountParam} now={p.now} />;
}
