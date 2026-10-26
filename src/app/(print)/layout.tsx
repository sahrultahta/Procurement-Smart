import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getRequestContext } from '@/server/request-context';

/**
 * Printable documents: no navigation, only the document. The session is validated here as in the
 * app shell; the page's own query decides whether the signed-in person may see the document.
 */
export default async function PrintLayout({ children }: { children: ReactNode }) {
  const { actor } = await getRequestContext();
  if (!actor) redirect('/sign-in');
  return <main className="mx-auto max-w-4xl bg-background px-6 py-8 print:max-w-none print:p-0">{children}</main>;
}
