import type { Metadata } from 'next';
import { Instrument_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

const instrument = Instrument_Sans({ subsets: ['latin'], variable: '--font-instrument', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'SocialPilot AI', template: '%s | SocialPilot AI' },
  description: 'Plan, publish and answer across every client’s social channels.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={instrument.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
