import { json } from './client';
import type { EntryBoard, EntryRecord, EntryTf } from '@/types/entry';

/** The 24 reads: with the timeframe chain (entry on 5m), and without it on `tf`. */
export const getEntryBoard = (tf: EntryTf = '5m') => json<EntryBoard>(`/api/entry/board?tf=${tf}`);

/** Each method's paper record, with the chain and without it, and the latest setups. */
export const getEntryRecord = () => json<{ records: EntryRecord[]; recent: unknown[] }>('/api/entry/record');
