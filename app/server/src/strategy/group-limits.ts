import { groupOwn, type Settings } from '../db/settings.js';
import {
  GLOBAL_MAX_OPEN_KEY, MOMENTUM_GUARD_KEY, REENTRY_KEY, SIDE_MAX_KEYS, STRIKE_FULL_KEY, STRIKE_MAX_KEY, ZONE_FRESH_KEY,
  globalMaxOpenOf, momentumGuardOf, reentryOf, sideCaps, sideMaxOf, strikeCapOf, strikeFullOf, strikeMaxOf, zoneFreshOf,
  type MomentumGuard, type Reentry, type SignalTf, type StrikeFull,
} from './types.js';

/**
 * A group's own limits (owner, 8 Nov 2026: "every account has these settings, but change them for each group -- tomorrow I
 * make groups"). The seven settings of an account's signal strategies -- at most open, each side's most, the most on one
 * strike and what a full strike does, the fill window, the momentum guard and re-entry -- each may be set for a group, kept
 * as `<key>@g:<group id>` (`groupKey`). One not set is its account's.
 *
 * The account stays the ceiling: its margin is one pool at Delta. The account's at most open, side and strike limits still
 * count every trade it holds; a group's count only its own strategies' trades, against its own numbers. A limit of the
 * group's is a per cent of the group's at most open where it has one, else of the account's -- and counted over fewer
 * trades than the account's, it never lets through what the account's would stop.
 */
export const GROUP_SETTING_KEYS = {
  maxOpen: GLOBAL_MAX_OPEN_KEY, ce: SIDE_MAX_KEYS.CE, pe: SIDE_MAX_KEYS.PE, strikeMax: STRIKE_MAX_KEY, strikeFull: STRIKE_FULL_KEY,
  zoneFresh: ZONE_FRESH_KEY, momentum: MOMENTUM_GUARD_KEY, reentry: REENTRY_KEY,
} as const;
export type GroupSettingName = keyof typeof GROUP_SETTING_KEYS;

/** A group's own values, read; null where it has none of its own and takes its account's. */
export type GroupOwn = {
  maxOpen: number | null; ce: number | null; pe: number | null; strikeMax: number | null; strikeFull: StrikeFull | null;
  zoneFresh: Record<SignalTf, number> | null; momentum: MomentumGuard | null; reentry: Reentry | null;
};
export const NO_GROUP_OWN: GroupOwn = { maxOpen: null, ce: null, pe: null, strikeMax: null, strikeFull: null, zoneFresh: null, momentum: null, reentry: null };

export function groupOwnOf(s: Settings, groupId: string | null | undefined): GroupOwn {
  if (!groupId) return NO_GROUP_OWN;
  const raw = (name: GroupSettingName) => groupOwn(s, GROUP_SETTING_KEYS[name], groupId);
  const read = <T>(name: GroupSettingName, of: (r: string) => T): T | null => { const r = raw(name); return r === null ? null : of(r); };
  // A stored at most open that will not read is none of the group's own: 0 would read as "no limit".
  const maxOpen = read('maxOpen', globalMaxOpenOf);
  return {
    maxOpen: maxOpen === 0 ? null : maxOpen,
    ce: read('ce', sideMaxOf), pe: read('pe', sideMaxOf), strikeMax: read('strikeMax', strikeMaxOf),
    strikeFull: read('strikeFull', strikeFullOf), zoneFresh: read('zoneFresh', zoneFreshOf),
    momentum: read('momentum', momentumGuardOf), reentry: read('reentry', reentryOf),
  };
}

/** Whether a group counts its own trades at all: it has its own at most open, side or strike limit. */
export const countsOwn = (own: GroupOwn): boolean => own.maxOpen !== null || own.ce !== null || own.pe !== null || own.strikeMax !== null;

export type GroupLimits = {
  /** The group's at most open: its own, or its account's (`own`: its own). */
  cap: number; own: boolean;
  sidePct: { CE: number; PE: number }; sides: { CE: number; PE: number } | null;
  strikePct: number; strikeCap: number | null;
};
/** What a group's trades are held to; null where it sets none of the counted limits (its account's alone stand). */
export function groupLimitsOf(own: GroupOwn, account: { cap: number; sidePct: { CE: number; PE: number }; strikePct: number }): GroupLimits | null {
  if (!countsOwn(own)) return null;
  const cap = own.maxOpen ?? account.cap;
  const sidePct = { CE: own.ce ?? account.sidePct.CE, PE: own.pe ?? account.sidePct.PE };
  const strikePct = own.strikeMax ?? account.strikePct;
  return { cap, own: own.maxOpen !== null, sidePct, sides: sideCaps(cap, sidePct), strikePct, strikeCap: strikeCapOf(cap, strikePct) };
}

/**
 * Why a signal of the group's is not taken, by its at most open and its side's limit, in words; null when it may go on.
 * `open`: the group's own open trades -- positions and working orders -- as the account's limits count theirs.
 */
export function groupBlock(limits: GroupLimits, open: readonly { optionSide: 'CE' | 'PE' }[], side: 'CE' | 'PE', name: string): string | null {
  if (limits.own && limits.cap > 0 && open.length >= limits.cap) {
    return `the group ${name} already has ${open.length} open -- at most ${limits.cap} at once in the group`;
  }
  if (limits.sides) {
    const held = open.filter((t) => t.optionSide === side).length;
    const most = limits.sides[side];
    if (held >= most) return `the group ${name} already has ${held} ${side} open -- at most ${most} ${side} (${limits.sidePct[side]}% of the group's ${limits.cap})`;
  }
  return null;
}
