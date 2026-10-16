import { Panel } from '@/components/mobile/parts';
import { MethodUpdatesLog } from '@/components/strategy/MethodUpdatesLog';

/**
 * More → Method updates (owner, 16 Oct 2026): every change to the signal strategies' methods, the daily update's
 * and the form's, for the account shown. The log itself is the desk's (Logs → Method updates).
 */
export function MethodLogScreen() {
  return (
    <Panel>
      <MethodUpdatesLog compact />
    </Panel>
  );
}
