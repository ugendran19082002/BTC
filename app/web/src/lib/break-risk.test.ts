import { describe, expect, it } from 'vitest';
import { risk } from '@/test/fixtures/break-risk';
import { curveAt, oneIn, parseOption, strikeRisk } from './break-risk';

describe('reading the measured curve', () => {
  it('interpolates between steps and holds flat past the last', () => {
    expect(curveAt([0, 1, 2], [1, 0.5, 0.1], 0.5)).toBeCloseTo(0.75);
    expect(curveAt([0, 1, 2], [1, 0.5, 0.1], 9)).toBe(0.1);
    expect(curveAt([0, 1, 2], [1, 0.5, 0.1], -1)).toBe(1);
  });

  it('[critical] a short call on an up break reads the with-the-break curve, from the break\'s close', () => {
    // 84,400 CE is 300 pts = 3 ATR above the 84,100 close: a quarter of up-break hours reached it.
    const r = strikeRisk(risk(), 84_400, 'C');
    expect(r.distance).toBe(300);
    expect(r.chance).toBeCloseTo(0.25);
    expect(r.level).toBe('IN_THE_WAY');
  });

  it('[critical] a short put on an up break reads the against curve: the other way is measured too', () => {
    const r = strikeRisk(risk(), 83_800, 'P');
    expect(r.chance).toBeCloseTo(0.1);
    expect(r.level).toBe('WATCH');
  });

  it('a strike already through at the break is certain, and far strikes are clear', () => {
    expect(strikeRisk(risk(), 84_000, 'C').chance).toBe(1);
    expect(strikeRisk(risk(), 90_000, 'C').level).toBe('CLEAR');
  });

  it('a down break flips which curve hurts which side', () => {
    const down = risk({ side: 'DOWN' });
    expect(strikeRisk(down, 83_800, 'P').chance).toBeCloseTo(0.25);
    expect(strikeRisk(down, 84_400, 'C').chance).toBeCloseTo(0.1);
  });
});

describe('the words', () => {
  it('says a share as one in n', () => {
    expect(oneIn(0.25)).toBe('1 in 4');
    expect(oneIn(0.1)).toBe('1 in 10');
    expect(oneIn(0.97)).toBe('almost all');
    expect(oneIn(0.001)).toBe('almost none');
  });
  it('reads an option symbol, and nothing else', () => {
    expect(parseOption('C-BTC-84600-270926')).toEqual({ cp: 'C', strike: 84_600 });
    expect(parseOption('P-BTC-83000-270926')).toEqual({ cp: 'P', strike: 83_000 });
    expect(parseOption('BTCUSD')).toBeNull();
  });
});
