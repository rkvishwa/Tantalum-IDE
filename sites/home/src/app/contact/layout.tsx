import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Get in touch with Knurdz. Open an issue, start a collaboration, or send us a message — we'd love to hear from you.",
  alternates: { canonical: "https://knurdz.org/contact" },
  openGraph: {
    title: "Contact Knurdz",
    description:
      "Get in touch with Knurdz. Open an issue, start a collaboration, or send us a message — we'd love to hear from you.",
    url: "https://knurdz.org/contact",
  },
};

export default function ContactLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
