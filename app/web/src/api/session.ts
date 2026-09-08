import { json } from '@/api/client';

export function getMe() {
  return json<{ required: boolean; signedIn: boolean; username: string | null }>('/api/me');
}

export async function login(username: string, password: string) {
  const res = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; username?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function logout() {
  return fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
}
