import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Projects",
  description:
    "Browse all Knurdz open-source projects — from web apps and developer tools to hardware and AI integrations. Fork, contribute, and deploy.",
  alternates: { canonical: "https://knurdz.org/projects" },
  openGraph: {
    title: "Knurdz Projects — Open Source Portfolio",
    description:
      "Browse all Knurdz open-source projects — from web apps and developer tools to hardware and AI integrations.",
    url: "https://knurdz.org/projects",
  },
};

export default function ProjectsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
