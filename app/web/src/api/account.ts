import type { AccountResponse } from '@/types/desk';

/** 501 here is not an error: it is the server saying no key is configured. */
export async function getAccount(): Promise<AccountResponse> {
  const res = await fetch('/api/account');
  return (await res.json()) as AccountResponse;
}
