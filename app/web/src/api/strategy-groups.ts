/** Which group each strategy is in, every account's (server: GET /api/strategy-groups/index). */
export type GroupIndex = {
  groups: { id: string; name: string; accountId: number | null; accountName: string | null }[];
  /** Strategy id -> group id; a strategy in no group is not in it. */
  of: Record<string, string>;
};

/**
 * Read quietly: the index only puts a tag beside a strategy's name, and a screen without it is the screen as it
 * was -- so a failure is no answer (null), never an error said or logged.
 */
export const getGroupIndex = (): Promise<GroupIndex | null> =>
  fetch('/api/strategy-groups/index', { credentials: 'same-origin' })
    .then((r) => (r.ok ? (r.json() as Promise<GroupIndex>) : null))
    .catch(() => null);
