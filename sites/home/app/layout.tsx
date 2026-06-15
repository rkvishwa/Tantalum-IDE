import type { Metadata } from 'next';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { ThemeProvider } from '@/components/ThemeProvider';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Tantalum IDE',
    template: '%s · Tantalum IDE',
  },
  description: 'Desktop Arduino IDE with cloud boards, OTA firmware releases, and managed coding agents.',
  icons: {
    icon: [
      { url: '/logos/tantalum-logo-light.svg', media: '(prefers-color-scheme: light)' },
      { url: '/logos/tantalum-logo-dark.svg', media: '(prefers-color-scheme: dark)' },
    ],
    apple: [
      { url: '/logos/tantalum-logo-light-192.png', media: '(prefers-color-scheme: light)' },
      { url: '/logos/tantalum-logo-dark-192.png', media: '(prefers-color-scheme: dark)' },
    ],
  },
  manifest: '/manifest.webmanifest',
  openGraph: {
    title: 'Tantalum IDE',
    description: 'Desktop Arduino IDE with cloud boards, OTA firmware releases, and managed coding agents.',
    type: 'website',
  },
};

const themeScript = `
(function() {
  try {
    var key = 'tantalum-site-theme';
    var stored = localStorage.getItem(key);
    var pref = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark';
    var resolved = pref === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : pref;
    document.documentElement.dataset.theme = resolved;
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>
          <div className="site-shell">
            <SiteHeader />
            {children}
            <SiteFooter />
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
