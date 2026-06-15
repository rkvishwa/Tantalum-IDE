import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Partners",
  description:
    "Explore Knurdz's industry partnerships. We collaborate with leading organizations to ship production-ready, real-world solutions.",
  alternates: { canonical: "https://knurdz.org/partners" },
  openGraph: {
    title: "Knurdz Partners",
    description:
      "Explore Knurdz's industry partnerships. We collaborate with leading organizations to ship production-ready, real-world solutions.",
    url: "https://knurdz.org/partners",
  },
};

export default function PartnersLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
