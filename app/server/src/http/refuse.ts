import type { FastifyReply } from 'fastify';

/**
 * An answer of "no", said deliberately.
 *
 * The error log is only worth reading if everything in it needs fixing, and
 * this desk says no for a living: the spread is too wide, the premium is under
 * the floor, the mode cannot flip while a position is open. Those are the gates
 * working. A status code alone cannot tell them apart from a 4xx the desk did
 * not mean to send -- our own screen posting a request with no `tradeId` is a
 * real bug and looks identical from the outside.
 *
 * So the route says which it is, rather than the log guessing. `refuse` sets
 * the status and marks the reply as intentional; the response hook in app.ts
 * skips anything marked. Everything unmarked is still recorded, which keeps the
 * default on the safe side: forgetting to call this makes the log noisier, not
 * blinder.
 */
const DELIBERATE = Symbol('desk.deliberate-refusal');

type Marked = { [DELIBERATE]?: true };

/** Answer with `body` at `code`, and keep it out of the error log. */
export function refuse<T>(reply: FastifyReply, code: number, body: T): T {
  reply.code(code);
  (reply as unknown as Marked)[DELIBERATE] = true;
  return body;
}

/** True when a route chose this status as its answer. */
export const wasRefusal = (reply: FastifyReply): boolean =>
  (reply as unknown as Marked)[DELIBERATE] === true;

/**
 * Whether a finished response belongs in the error log.
 *
 * Pulled out of the hook so the rule can be stated once and tested, rather than
 * living as a chain of `||` nobody re-reads. Three kinds stay out:
 *
 *   - anything that succeeded;
 *   - not-signed-in and not-found, which are states a browser reaches by
 *     ordinary navigation and would drown everything else;
 *   - a refusal the route meant, marked by `refuse`.
 *
 * Everything else is in, including a 400. Our own screen sending a request
 * without a `tradeId` is a bug in our own screen, and the only way anyone finds
 * out is if it is recorded.
 */
export function worthLogging(statusCode: number, deliberate: boolean): boolean {
  if (statusCode < 400) return false;
  if (statusCode === 401 || statusCode === 404) return false;
  return !deliberate;
}
