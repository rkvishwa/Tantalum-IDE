import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  weight: ["400", "500", "600", "700", "800"],
});

const BASE_URL = "https://knurdz.org";

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: "Knurdz — Tech Community & Open Source Organization",
    template: "%s — Knurdz",
  },
  description:
    "From code to silicon and social impact. Explore innovative projects, meet our partners, and join the Knurdz community in building tech that matters. Fork, commit, deploy.",
  keywords: [
    "Knurdz",
    "tech community",
    "open source",
    "software projects",
    "developers",
  ],
  authors: [{ name: "Knurdz", url: BASE_URL }],
  creator: "Knurdz",
  publisher: "Knurdz",
  alternates: {
    canonical: BASE_URL,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  // Add your Google Search Console verification token below once you have it
  // verification: {
  //   google: "YOUR_GSC_VERIFICATION_TOKEN_HERE",
  // },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
  openGraph: {
    title: "Knurdz — Tech Community & Open Source Organization",
    description:
      "From code to silicon and social impact. Explore innovative projects, meet our partners, and join the Knurdz community in building tech that matters.",
    url: BASE_URL,
    siteName: "Knurdz",
    images: [
      {
        url: "/logo/knurdz-logo-horizontal-bg.png",
        width: 600,
        height: 200,
        alt: "Knurdz — Tech Community & Open Source Organization",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Knurdz — Tech Community & Open Source Organization",
    description:
      "From code to silicon and social impact. Explore innovative projects, meet our partners, and join the Knurdz community in building tech that matters.",
    site: "@knurdz_org",
    creator: "@knurdz_org",
    images: ["/logo/knurdz-logo-horizontal-bg.png"],
  },
};

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Knurdz",
  url: BASE_URL,
  description:
    "From code to silicon and social impact. A tech community building open-source projects that matter.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} bg-background text-foreground antialiased transition-colors duration-300`}
        style={{ fontFamily: "var(--font-space-grotesk), sans-serif" }}
      >
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
