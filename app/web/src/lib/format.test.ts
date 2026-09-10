import { describe, expect, it } from 'vitest';
import {
  ago, clock, contractLabel, countdown, duration, inr, pct, price, signedUsd, size, stamp,
  strike, tone, usd,
} from '@/lib/format';

describe('price', () => {
  it('always shows two places so a column lines up', () => {
    expect(price(9)).toBe('9.00');
    expect(price(11.5)).toBe('11.50');
    expect(price(100.456)).toBe('100.46');
  });

  it('shows a dash rather than a zero when there is no price', () => {
    // 0.00 would read as "this is worth nothing", which is a different claim
    expect(price(null)).toBe('—');
    expect(price(undefined)).toBe('—');
    expect(price(Number.NaN)).toBe('—');
  });

  it('does not confuse a real zero with a missing one', () => {
    expect(price(0)).toBe('0.00');
  });
});

describe('usd', () => {
  it('keeps cents on small amounts and drops them on large ones', () => {
    expect(usd(33)).toBe('$33.00');
    expect(usd(1234.56)).toBe('$1,235');
  });

  it('goes to three places under a dollar, where the cents are the whole number', () => {
    // a contract is a thousandth of a BTC, so these sums really are this small:
    // writing $0.0066 as "$0.01" rounds away two thirds of it
    expect(usd(0.0066)).toBe('$0.007');
    expect(usd(0.04)).toBe('$0.040');
    expect(usd(-0.019)).toBe('$-0.019');
  });

  it('treats a dollar and zero as ordinary money', () => {
    expect(usd(1)).toBe('$1.00');
    expect(usd(0)).toBe('$0.00');
  });

  it('rounds a real but tiny amount up to the smallest place, never down to zero', () => {
    // "$0.000" reads as exactly nothing, which is a different claim
    expect(usd(0.0001)).toBe('$0.001');
    expect(usd(-0.0001)).toBe('-$0.001');
    expect(inr(0.001)).toBe('₹0.01');
  });

  it('has nothing to say about a missing number', () => {
    expect(usd(null)).toBe('—');
  });
});

describe('signedUsd', () => {
  it('leads with the sign, because the sign is the point', () => {
    expect(signedUsd(33)).toBe('+$33.00');
    expect(signedUsd(-49)).toBe('−$49.00');
    // no sign on nothing: "+$0.00" reads as a gain that is not there
    expect(signedUsd(0)).toBe('$0.00');
  });
  it('uses a real minus sign, not a hyphen', () => {
    expect(signedUsd(-1)).toContain('−');
  });
});

describe('inr', () => {
  it('groups the Indian way', () => {
    expect(inr(1_00_000)).toBe('₹1,00,000');
  });
});

describe('pct', () => {
  it('turns a fraction into a percentage', () => {
    expect(pct(0.9907, 2)).toBe('99.07%');
    expect(pct(0.05, 0)).toBe('5%');
  });
  it('does not invent a percentage from nothing', () => {
    expect(pct(null)).toBe('—');
  });
});

describe('strike and size', () => {
  it('groups thousands', () => {
    expect(strike(80_000)).toBe('80,000');
    expect(size(1_500)).toBe('1,500');
  });
  it('reports a short position by its magnitude', () => {
    // the sign is carried by the word "short", not by the number beside it
    expect(size(-100)).toBe('100');
  });
});

describe('countdown', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);
  it('counts hours and minutes while there is time', () => {
    expect(countdown(now + 4 * 3600_000 + 12 * 60_000, now)).toBe('4h 12m left');
  });
  it('drops to minutes and seconds inside the last hour', () => {
    expect(countdown(now + 90_000, now)).toBe('1m 30s left');
    expect(countdown(now + 8_000, now)).toBe('8s left');
  });
  it('says settled rather than counting backwards', () => {
    expect(countdown(now - 1, now)).toBe('settled');
    expect(countdown(now, now)).toBe('settled');
  });
});

describe('ago', () => {
  const now = 1_700_000_000_000;
  it('reads as a feed that is moving', () => {
    expect(ago(now - 500, now)).toBe('just now');
    expect(ago(now - 8_000, now)).toBe('8s ago');
    expect(ago(now - 3 * 60_000, now)).toBe('3m ago');
    expect(ago(now - 2 * 3600_000, now)).toBe('2h ago');
  });
  it('never reports the future as a negative age', () => {
    expect(ago(now + 5_000, now)).toBe('just now');
  });
});

describe('clock and stamp', () => {
  it('renders in IST, because the desk only ever runs in IST', () => {
    // 12:00 UTC is 17:30 IST, which is when the daily contract settles
    expect(clock(Date.UTC(2026, 8, 8, 12, 0))).toBe('17:30');
    expect(stamp(Date.UTC(2026, 8, 8, 12, 0))).toContain('17:30');
  });
  it('has nothing to show for a missing time', () => {
    expect(clock(null)).toBe('—');
  });
});

describe('tone', () => {
  it('treats zero as neither direction', () => {
    expect(tone(0)).toBe('flat');
    expect(tone(null)).toBe('flat');
    expect(tone(1)).toBe('up');
    expect(tone(-1)).toBe('down');
  });
});

describe('contractLabel', () => {
  it('says what a trader would say out loud', () => {
    expect(contractLabel('C-BTC-80000-080926')).toBe('80,000 CE');
    expect(contractLabel('P-BTC-77600-080926')).toBe('77,600 PE');
  });
  it('falls back to the symbol rather than printing NaN', () => {
    expect(contractLabel('nonsense')).toBe('nonsense');
  });
});

describe('duration', () => {
  it('says seconds on their own under a minute', () => {
    expect(duration(42_000)).toBe('42s');
    expect(duration(1_000)).toBe('1s');
  });

  it('pads the smaller unit so a column of them lines up', () => {
    expect(duration(208_000)).toBe('3m 28s');
    expect(duration(65_000)).toBe('1m 05s');
    expect(duration(3_840_000)).toBe('1h 04m');
  });

  it('drops seconds past an hour, where they stop meaning anything', () => {
    expect(duration(7_200_000)).toBe('2h 00m');
  });

  it('rounds rather than truncating, so 1.6s is not 1s', () => {
    expect(duration(1_600)).toBe('2s');
  });

  it('has nothing to say about a missing or impossible span', () => {
    expect(duration(null)).toBe('—');
    expect(duration(undefined)).toBe('—');
    expect(duration(-5_000)).toBe('—');
    expect(duration(Number.NaN)).toBe('—');
  });
});
