import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About",
  description:
    "Learn about Knurdz — a community of passionate developers, designers, and innovators building the future of tech together. Founded in 2025.",
  alternates: { canonical: "https://knurdz.org/about" },
  openGraph: {
    title: "About Knurdz — Tech Community",
    description:
      "Learn about Knurdz — a community of passionate developers, designers, and innovators building the future of tech together.",
    url: "https://knurdz.org/about",
  },
};

export default function AboutLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
