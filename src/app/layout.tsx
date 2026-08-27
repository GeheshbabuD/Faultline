import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, Geist_Mono } from 'next/font/google';
import { ThemeProvider, themeInitScript } from '@/ui/theme';
import './globals.css';

/**
 * Instrument Sans for the interface: a precise grotesque that stays legible at
 * the small sizes this product depends on, without reading as a default.
 * Geist Mono is reserved for diagnostic identifiers, reasoning expressions and
 * confidence figures — never for prose.
 */
const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument-sans',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Faultline',
    template: '%s · Faultline',
  },
  description: "Don't grade the answer. Debug the reasoning.",
  applicationName: 'Faultline',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1b1a' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={`${instrumentSans.variable} ${geistMono.variable} antialiased`}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
