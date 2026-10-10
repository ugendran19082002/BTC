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
  const sections: GroupSection[] = inOrder(groups).map((g) => ({ group: g, strategies: byPosition(strategies.filter((s) => s.groupId === g.id)) }));
  const loose = strategies.filter((s) => !s.groupId || !known.has(s.groupId));
  if (loose.length > 0) sections.push({ group: null, strategies: loose });
  return sections;
}

/**
 * In the order set by hand (`position`, owner 10 Oct 2026: "change the display order"); those without one after,
 * in the order given -- where they were made. Stable: equal places keep the order they came in.
 */
export function byPosition<T extends { position?: number | null }>(xs: readonly T[]): T[] {
  return xs.map((x, i) => ({ x, i })).sort((a, b) => ((a.x.position ?? Infinity) - (b.x.position ?? Infinity)) || a.i - b.i).map((o) => o.x);
}

/** The groups, each account's together where it first comes, and within an account in its own order. */
export function inOrder(groups: readonly StrategyGroup[]): StrategyGroup[] {
  const accounts = [...new Set(groups.map((g) => g.accountId ?? null))];
  return accounts.flatMap((a) => byPosition(groups.filter((g) => (g.accountId ?? null) === a)));
}

/** The list with one item moved one place up (-1) or down (+1); unchanged at either end. */
export function moved<T>(xs: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (i < 0 || j < 0 || j >= xs.length) return [...xs];
  const out = [...xs];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** The list with the item at `from` taken out and put at `to`. */
export function moveTo<T>(xs: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= xs.length) return [...xs];
  const out = [...xs];
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, x!);
  return out;
}

/**
 * Where a row being dragged belongs (owner, 10 Oct 2026: "drag to change the order"): the number of the other rows
 * whose middle is above the pointer -- `middles` are theirs, top to bottom, the dragged row's own left out.
 */
export function dropIndex(middles: readonly number[], y: number): number {
  return middles.filter((m) => m < y).length;
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

/** One account's strategies to copy from, by group (the copy picker). */
export type CopySource = { accountId: number | null; accountName: string; sections: GroupSection[] };

/**
 * What can be copied, by account and then by group (owner, 10 Oct 2026: "from another account's, another group's"):
 * every account's strategies, those of the group being copied into left out -- they are in it already. The account
 * being shown first, then the others in their order; a search keeps the strategies whose name has it.
 */
export function copySources(
  strategies: readonly Strategy[], groups: readonly StrategyGroup[],
  accounts: readonly { id: number; name: string }[],
  o: { exceptGroupId?: string | null; firstAccount?: number | null; search?: string } = {},
): CopySource[] {
  const q = (o.search ?? '').trim().toLowerCase();
  const pool = strategies.filter((s) => (!o.exceptGroupId || s.groupId !== o.exceptGroupId) && (!q || s.name.toLowerCase().includes(q)));
  const ids = [...new Set([...accounts.map((a) => a.id as number | null), ...groups.map((g) => g.accountId), ...pool.map((s) => s.accountId ?? null)])];
  ids.sort((a, b) => Number(b === (o.firstAccount ?? null)) - Number(a === (o.firstAccount ?? null)));
  return ids.map((id) => {
    const own = pool.filter((s) => (s.accountId ?? null) === id);
    const sections = groupSections(own, groups.filter((g) => g.accountId === id && g.id !== o.exceptGroupId))
      .filter((sec) => sec.strategies.length > 0);
    const name = accounts.find((a) => a.id === id)?.name ?? groups.find((g) => g.accountId === id)?.accountName ?? (id === null ? 'No account' : `Account ${id}`);
    return { accountId: id, accountName: name, sections };
  }).filter((a) => a.sections.length > 0);
}

/** The server's rule (strategy/types.ts `groupNameProblem`), said before sending. */
export function groupNameProblem(name: string): string | null {
  if (!name.trim()) return 'Give the group a name.';
  if (name.trim().length > 40) return 'A group name is at most 40 characters.';
  return null;
}
