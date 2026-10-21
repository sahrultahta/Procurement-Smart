'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '@/server/auth';

/**
 * Sign-out as a Server Action, so it works as a plain form POST. Next.js rejects
 * cross-origin calls (Origin vs Host), and Better Auth deletes the session row,
 * so a copied cookie stops working immediately (P3a-AC4).
 */
export async function signOutAction(): Promise<void> {
  await getAuth().api.signOut({ headers: await headers() });
  redirect('/sign-in');
}
