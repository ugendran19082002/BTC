import { migrate, moveToPublic, type Migration } from './migrate.js';

/**
 * The analytics tables are created and written by the Python side
 * (research/publish_outlook_states.py) and read by the Python service; nothing
 * in Node reads them. They are here only so that moving them into `public`
 * happens under the same ledger as every other table, at the desk's boot.
 */
const MIGRATIONS: Migration[] = [
  {
    /*
     * Every table in one schema, public, on the owner's request (19 Sep 2026).
     * publish_meta becomes analytics_publish_meta: a bare name would say nothing.
     */
    id: 'analytics-001-to-public',
    up: moveToPublic([
      ['analytics.outlook_states', 'outlook_states'],
      ['analytics.chain_states', 'chain_states'],
      ['analytics.publish_meta', 'analytics_publish_meta'],
    ], ['analytics']),
  },
];

export const analyticsSchema = (): Promise<string[]> => migrate(MIGRATIONS);
