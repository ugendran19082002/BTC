/**
 * What the browser tab says: the price, how far it has come today, and the
 * day's P&L -- the three numbers somebody glances at from another tab.
 *
 *   "78,397 +88 · +₹4,354 · BTC Desk"
 *
 * The move is only written once it is the day's (since 05:30 IST); a move since
 * the page opened is not worth a glance. Nothing signed in, nothing but the
 * name: a title is visible to anyone who can see the screen.
 */
export function tabTitle(t: {
  signedIn: boolean;
  spot: number | null;
  /** Dollars since 05:30 IST today, or null while that has not arrived. */
  dayMoveUsd: number | null;
  /** Today's net, in rupees, signed. Null before the server has answered. */
  todayInr: string | null;
}): string {
  const name = 'BTC Desk';
  if (!t.signedIn || t.spot === null) return name;
  const parts = [Math.round(t.spot).toLocaleString('en-IN')];
  if (t.dayMoveUsd !== null) parts[0] += ` ${t.dayMoveUsd >= 0 ? '+' : '−'}${Math.abs(Math.round(t.dayMoveUsd))}`;
  if (t.todayInr !== null) parts.push(t.todayInr);
  parts.push(name);
  return parts.join(' · ');
}
