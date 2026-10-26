import type { Metadata } from 'next';
import { Geist, Petrona } from 'next/font/google';

import { TopBar } from '@/components/TopBar';

import './globals.css';

const petrona = Petrona({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-petrona' });
const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });

export const metadata: Metadata = {
  title: 'Baby Book Preview',
  description: 'Put a child into a picture book: import, prepare, generate.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${petrona.variable} ${geist.variable}`}>
      <body>
        <TopBar />
        {children}
      </body>
    </html>
  );
}
