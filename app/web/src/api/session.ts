/**
 * Sign-in and the account page.
 *
 * Not through `json()`: that turns every 401 into "not signed in", and here a
 * 401 is usually the answer to show -- a wrong password, a wrong code -- with
 * the server's words in it.
 */

export type Stage = 'none' | 'totp' | 'setup' | 'full';

export type Me = {
  required: boolean;
  /** False when the server has no user or no secret yet: nobody can sign in. */
  configured?: boolean;
  stage?: Stage;
  signedIn: boolean;
  username: string | null;
  expiresAt?: number | null;
};

export type SecurityEvent = { id: number; at: number; kind: string; ip: string | null; detail: string | null };

export type Account = {
  username: string;
  passwordChangedAt: number;
  twoFactorSince: number | null;
  recoveryCodesLeft: number;
  sessionExpiresAt: number;
  sessions: { id: string; current: boolean; createdAt: number; lastSeenAt: number; expiresAt: number; ip: string | null; device: string }[];
  events: SecurityEvent[];
};

export class AuthError extends Error {
  constructor(message: string, readonly status: number, readonly problems: string[] = [], readonly restart = false) {
    super(message);
    this.name = 'AuthError';
  }
}

async function call<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; problems?: string[]; restart?: boolean };
  if (!res.ok) throw new AuthError(body.error ?? `HTTP ${res.status}`, res.status, body.problems ?? [], Boolean(body.restart));
  return body as T;
}

export const getMe = () => call<Me>('/api/me');

export const login = (username: string, password: string) =>
  call<{ ok: true; next: 'code' | 'setup' }>('/api/login', { method: 'POST', body: { username, password } });

export const submitCode = (code: string) =>
  call<{ ok: true; usedRecoveryCode: boolean }>('/api/login/code', { method: 'POST', body: { code } });

export const getSetup = () => call<{ secret: string; otpauthUrl: string; qrSvg: string }>('/api/security/setup');

export const enableTwoStep = (code: string) =>
  call<{ ok: true; recoveryCodes: string[] }>('/api/security/enable', { method: 'POST', body: { code } });

export const getAccount = () => call<Account>('/api/security');

export const changePassword = (b: { current: string; next: string; code: string }) =>
  call<{ ok: true; endedSessions: number }>('/api/security/password', { method: 'POST', body: b });

export const newRecoveryCodes = (code: string) =>
  call<{ ok: true; recoveryCodes: string[] }>('/api/security/recovery-codes', { method: 'POST', body: { code } });

export const signOutOthers = () => call<{ ok: true; ended: number }>('/api/security/sign-out-others', { method: 'POST', body: {} });

export function logout() {
  return fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
}
