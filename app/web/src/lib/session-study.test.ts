import { describe, expect, it } from 'vitest';
import { BLANK_FIGURES, SESSION_DRAFTS, nextSession, ruleWords, sessionAskOf, sessionDraftProblem, spanOf, splitDay, type SessionDrafts } from '@/lib/session-study';
import { sessionQuery } from '@/api/signal-backtest';

const of = (sessions: SessionDrafts['sessions'], win: Partial<SessionDrafts['win']> = {}): SessionDrafts => ({ sessions, win: { ...SESSION_DRAFTS.win, ...win } });
const s = (from: string, to: string, o: Partial<typeof BLANK_FIGURES> = {}) => ({ from, to, ...BLANK_FIGURES, ...o });

describe('the session study as typed (23 Oct 2026)', () => {
  it('[critical] held to the server\'s own rules, in words: times, overlap, past 5:30 PM, each figure, and something set', () => {
    expect(sessionDraftProblem(SESSION_DRAFTS)).toBeNull();
    expect(sessionDraftProblem(of([]))).toMatch(/Add a session/);
    expect(sessionDraftProblem(of([s('10:00', '10:00', { sl: '150' })]))).toMatch(/must differ/);
    expect(sessionDraftProblem(of([s('16:00', '18:00', { sl: '150' })]))).toMatch(/runs past 5:30 PM/);
    expect(sessionDraftProblem(of([s('18:00', '20:00', { sl: '150' }), s('19:00', '21:00', { sl: '150' })]))).toMatch(/Sessions 1 and 2 overlap/);
    // Over midnight, read forward from 5:30 PM: not an overlap, not past the day's end.
    expect(sessionDraftProblem(of([s('23:00', '01:00', { sl: '150' }), s('01:00', '17:30', { delta: '0.08' })]))).toBeNull();
    expect(sessionDraftProblem(of([s('18:00', '20:00', { delta: '0.9' })]))).toMatch(/delta is from 0\.02 to 0\.50/);
    expect(sessionDraftProblem(of([s('18:00', '20:00', { sl: '5' })]))).toMatch(/SL is from 10%/);
    expect(sessionDraftProblem(of([s('18:00', '20:00', { win: '101' })]))).toMatch(/win % is from 1%/);
    expect(sessionDraftProblem(of([s('18:00', '20:00')]))).toMatch(/blank everywhere is the settings as set/);
    // The SL and TGT range by session (24 Oct 2026): set alone it is something set; 0 is off; a maximum under its minimum refused.
    expect(sessionDraftProblem(of([s('18:00', '20:00', { slMin: '0' })]))).toBeNull();
    expect(sessionDraftProblem(of([s('18:00', '20:00', { tgtMax: '-5' })]))).toMatch(/SL or TGT distance is from 0 \(off\) to 20,000 points/);
    expect(sessionDraftProblem(of([s('18:00', '20:00', { slMin: '400', slMax: '300' })]))).toMatch(/Session 1's SL maximum must not be under its minimum/);
    expect(sessionDraftProblem(of([s('18:00', '20:00', { tgtMin: '400', tgtMax: '300' })]))).toMatch(/Session 1's TGT maximum/);
    expect(sessionDraftProblem(of([s('18:00', '20:00', { slMin: '400', slMax: '0' })]))).toBeNull();
    expect(sessionDraftProblem(of([s('18:00', '20:00', { sl: '150' })], { base: '0' }))).toMatch(/win % as set/);
    expect(sessionDraftProblem(of([s('18:00', '20:00', { sl: '150' })], { days: '31' }))).toMatch(/days read/);
  });

  it('[critical] asked with each blank a null, the SL in per cent, the sessions as JSON', () => {
    const a = sessionAskOf(of([s('12:00', '17:30', { sl: '150', win: '70' }), s('21:30', '23:30', { delta: '0.08' })], { base: '55' }));
    const none = { slMin: null, slMax: null, tgtMin: null, tgtMax: null };
    expect(a).toEqual({ sessions: [{ from: '12:00', to: '17:30', delta: null, sl: 150, win: 70, ...none }, { from: '21:30', to: '23:30', delta: 0.08, sl: null, win: null, ...none }], win: { base: 55, minTrades: 3, days: 14 } });
    expect(sessionAskOf(of([s('18:00', '20:00', { slMin: '150', tgtMax: '0' })])).sessions[0]).toMatchObject({ slMin: 150, slMax: null, tgtMin: null, tgtMax: 0 });
    expect(new URLSearchParams(sessionQuery(a)).get('ss')).toBe(JSON.stringify(a.sessions));
    expect(new URLSearchParams(sessionQuery(a)).get('swb')).toBe('55');
    expect(new URLSearchParams(sessionQuery({ ...a, win: { ...a.win, base: null } })).has('swb')).toBe(false);
  });

  it('a session added is the first free time from 5:30 PM, two hours or up to the next; none when the day is full; the day split', () => {
    expect(nextSession(of([]))).toEqual(s('17:30', '19:30'));
    expect(nextSession(of([s('17:30', '19:00', { sl: '1' })]))).toEqual(s('19:00', '21:00'));
    expect(nextSession(of([s('17:30', '19:00'), s('20:00', '22:00')]))).toEqual(s('19:00', '20:00'));
    expect(nextSession(SESSION_DRAFTS)).toEqual(s('17:30', '19:30'));
    expect(nextSession(of([s('17:30', '17:30')]))).toEqual(s('17:30', '19:30'));
    expect(nextSession(of(splitDay(6)))).toBeNull();
    expect(splitDay(6).map((x) => `${x.from}-${x.to}`)).toEqual(['17:30-23:30', '23:30-05:30', '05:30-11:30', '11:30-17:30']);
    expect(splitDay(4).length).toBe(6);
    expect(spanOf(s('11:30', '17:30'))).toEqual([1_080, 1_440]);
    expect(ruleWords({ delta: 0.08, sl: 1.5, win: 70 })).toBe('Δ 0.08 · SL +150% · won ≥ 70%');
    expect(ruleWords({ delta: null, sl: null, win: null })).toBe('as set');
    expect(ruleWords({ delta: null, sl: 2.5, win: null, slMin: 1500, slMax: null, tgtMin: null, tgtMax: 0 })).toBe('SL +250% · SL ≥ 1,500 pts · TGT ≤ off');
  });
});
