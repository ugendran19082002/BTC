/**
 * Why a signal was not taken, as keys (owner, 20 Oct 2026: "Not taken, tapped: sub-tabs -- the perp SL min not met, the
 * perp TGT min not met, max open full, and so on, all of them"). The runner writes each reason as a sentence
 * (`runner.ts` `takeSignal`, the strike pick in `select.ts`, the order's pre-check); these are those sentences read back
 * into a few kinds, so the screen can count and filter by them. One signal can have more than one -- its SL and its
 * TGT both too near -- and then it is under each.
 *
 * A refusal's sentence starts with the order it would have sold -- "sell PE 81400 x1 @ 13 · perp SL 81791 · TGT 81578
 * -- refused: ..." -- so only what follows "refused:" is read for it: the SL and TGT there are the order's, not a reason.
 */
export const SIGNAL_REASONS = [
  'sl-min', 'sl-max', 'tgt-min', 'tgt-max', 'own-max', 'desk-max', 'side-max', 'strike-max', 'no-entry', 'late', 'over',
  'premium', 'spread', 'no-strike', 'margin', 'loss-limit', 'no-board', 'delta', 'other',
] as const;
export type SignalReason = (typeof SIGNAL_REASONS)[number];

/** Each kind and the words that say it, tried in this order; the first that fits a part of the sentence is its kind. */
const KINDS: [SignalReason, RegExp][] = [
  ['sl-min', /\bSL too near\b/],
  ['sl-max', /\bSL too far\b/],
  ['tgt-min', /\bTGT too near\b/],
  ['tgt-max', /\bTGT too far\b/],
  ['no-entry', /no-entry window/i],
  ['late', /too late to enter/i],
  ['over', /over before it could be entered|in the same moment/i],
  ['side-max', /already has \d+ (CE|PE) open/],
  // Before the desk's own: "the desk already has 10 open on PE 83000" says the desk's words too.
  ['strike-max', /already has \d+ open on (CE|PE) \d+/],
  ['desk-max', /the desk already has \d+ open/],
  ['own-max', /^already \d+ of its trades? open/],
  ['loss-limit', /loss budget|loss limit/i],
  ['premium', /pays [\d.]+ and the desk will not sell below|premium floor|below the floor/i],
  ['spread', /^Spread is [\d.]+%/],
  ['margin', /margin (needed|required)|needs \$|not enough (margin|funds)|insufficient/i],
  ['no-strike', /no strike|nothing out of the money|rule failed|no wall within|nothing to sell|no [\d.]+ strike listed|not listed with a price|has no offer/i],
  ['no-board', /no live option board|not the daily contract/i],
  ['delta', /Delta refused|could not set .*leverage|Delta (did not|gave no) /i],
];

/** The kinds of reason in a not-taken signal's sentence; none for one that was taken. */
export function signalReasons(status: string, detail: string): SignalReason[] {
  if (status === 'placed' || status === 'would-place' || status === 'claimed') return [];
  // The reason itself: after the signal's own name ("#55 Pulled wall SELL | ..."), and for a refusal after "refused:".
  const said = detail.includes(' | ') ? detail.slice(detail.indexOf(' | ') + 3) : detail;
  const why = status === 'refused' && /\brefused: /.test(said) ? said.slice(said.lastIndexOf('refused: ') + 9) : said;
  const out: SignalReason[] = [];
  for (const part of why.split('; ')) {
    const hit = KINDS.find(([, re]) => re.test(part.trim()));
    const kind = hit ? hit[0] : 'other';
    if (!out.includes(kind)) out.push(kind);
  }
  return out.length ? out : ['other'];
}
