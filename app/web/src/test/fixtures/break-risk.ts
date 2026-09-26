import type { BreakRisk } from '@/api/desk';

/** A 30m up-break hour, with round numbers: ATR 100, closed at 84,100 over 84,000. */
export const risk = (p: Partial<BreakRisk> = {}): BreakRisk => ({
  tf: '30m', side: 'UP', level: 84_000, at: 0, until: 3_600_000, entry: 84_100, atr: 100,
  withPts: [250, 500, 900, 1_200], againstPts: [240, 430, 750, 1_000], eitherPts: [440, 1_130], baselinePts: [325, 845],
  bigger: 0.35, keptGoing: 0.46, keptGoingByYear: { 2024: { n: 390, keptGoing: 0.45 } }, n: 1_317, from: '2024-04-01', to: '2026-09-26',
  // 0..4 ATR: the break's way falls off slower than the other way.
  reach: { stepsAtr: [0, 1, 2, 3, 4, 5, 6], with: [1, 0.8, 0.5, 0.25, 0.1, 0.03, 0], against: [1, 0.6, 0.3, 0.1, 0.05, 0.01, 0] },
  ...p,
});
