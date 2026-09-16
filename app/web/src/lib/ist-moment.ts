/**
 * A date and time, always read as India time.
 *
 * The strategy is defined in IST -- entry 05:30, settlement 17:30 -- so a
 * moment on this desk is an IST wall-clock reading regardless of where the
 * browser is. Anything else makes "05:30" mean different moments to different
 * viewers, which is the one thing these helpers must never do.
 *
 * Kept apart from the picker that edits one: the Live screen needs the
 * arithmetic on first paint and the picker (with its calendar library) only
 * when somebody chooses a past date.
 */
export type IstMoment = { date: string; time: string };

/** Epoch seconds for an IST wall-clock moment. */
export function istToEpoch({ date, time }: IstMoment): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!, hh!, mm!) / 1000) - 5.5 * 3600;
}

export function nowIst(): IstMoment {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}
