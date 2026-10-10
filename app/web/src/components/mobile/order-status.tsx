import type { OrderRecord, OrderStatus } from '@/types/trade';
import { Pill } from '@/components/mobile/parts';

/**
 * An order's status as one word on a pill -- Home's latest order and the Orders list both say it. In a module of
 * its own (10 Oct 2026) so that Home, which comes with the phone, does not bring the Orders screen with it.
 */
const WORD: Record<OrderStatus, { label: string; tone: 'up' | 'down' | 'warn' | 'dim' }> = {
  completed: { label: 'FILLED', tone: 'up' },
  pending: { label: 'WORKING', tone: 'warn' },
  cancelled: { label: 'CANCELLED', tone: 'dim' },
  rejected: { label: 'REJECTED', tone: 'down' },
};

export const orderStatusWord = (o: Pick<OrderRecord, 'status'>) => <Pill tone={WORD[o.status].tone}>{WORD[o.status].label}</Pill>;
