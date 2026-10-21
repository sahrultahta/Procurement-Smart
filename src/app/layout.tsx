import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ProcureFlow', template: '%s · ProcureFlow' },
  description: 'Open-source procurement workflow system',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Render every page per request: the Content-Security-Policy nonce set in proxy.ts
  // can only be applied to dynamically rendered pages (Next.js CSP guide).
  await connection();
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
