import type { Strategy, StrategyGroup } from '@/types/strategy';

/**
 * The strategies listed by group (owner, 10 Oct 2026: "the strategies are listed by group now, each group's inside it").
 *
 * A group is a way of listing one account's strategies and of switching them together; it is not a switch of its
 * own, and nothing here decides what runs -- each strategy's own switch does, as before.
 */

/** One section of the list: a group and its strategies, or (group null) those in none. */
export type GroupSection = { group: StrategyGroup | null; strategies: Strategy[] };

/**
 * The groups in the server's order (each account's oldest first), each with its strategies in the list's order --
 * an empty group too, so one just made shows. Then the strategies in no group, if any: one whose group is not in
 * the list (a group removed a moment ago, say) is in none until the list is read again, never dropped.
 */
export function groupSections(strategies: readonly Strategy[], groups: readonly StrategyGroup[]): GroupSection[] {
  const known = new Set(groups.map((g) => g.id));
  const sections: GroupSection[] = groups.map((g) => ({ group: g, strategies: strategies.filter((s) => s.groupId === g.id) }));
  const loose = strategies.filter((s) => !s.groupId || !known.has(s.groupId));
  if (loose.length > 0) sections.push({ group: null, strategies: loose });
  return sections;
}

/** "3 of 5 on": how many of a group's strategies are switched on. */
export function onCount(strategies: readonly Strategy[]): { on: number; of: number } {
  return { on: strategies.filter((s) => s.enabled).length, of: strategies.length };
}

/** The groups a strategy can be moved to: its own account's (a group is one account's), not the one it is in. */
export function moveTargets(s: Strategy, groups: readonly StrategyGroup[]): StrategyGroup[] {
  return groups.filter((g) => (g.accountId ?? null) === (s.accountId ?? null) && g.id !== s.groupId);
}

/** The group a strategy made from the screen goes in: the account's first -- the one named after it. Null: none. */
export function defaultGroupFor(accountId: number | null, groups: readonly StrategyGroup[]): StrategyGroup | null {
  if (accountId === null) return null;
  return groups.find((g) => g.accountId === accountId) ?? null;
}

/**
 * Whose a group is, said beside its name on "All accounts" -- only where it adds something: a group named after its
 * account (each account's first, made so on 10 Oct 2026) read "High Win% High Win%".
 */
export function accountTag(g: Pick<StrategyGroup, 'name' | 'accountName'>): string | null {
  const a = g.accountName?.trim();
  return a && a.toLowerCase() !== g.name.trim().toLowerCase() ? a : null;
}

/** The server's rule (strategy/types.ts `groupNameProblem`), said before sending. */
export function groupNameProblem(name: string): string | null {
  if (!name.trim()) return 'Give the group a name.';
  if (name.trim().length > 40) return 'A group name is at most 40 characters.';
  return null;
}
