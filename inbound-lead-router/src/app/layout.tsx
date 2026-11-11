import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Inbound Lead Router',
  description: 'Enrich, score, route and alert on every inbound signup with CompanyEnrich.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <span className="font-semibold">Inbound Lead Router</span>
            <nav className="flex gap-4 text-sm">
              <Link href="/" className="text-slate-600 hover:text-slate-900">
                Signup demo
              </Link>
              <Link href="/playground" className="text-slate-600 hover:text-slate-900">
                Rules playground
              </Link>
            </nav>
            <a href="https://docs.companyenrich.com" className="ml-auto text-sm text-slate-500 hover:text-slate-900">
              CompanyEnrich docs
            </a>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
