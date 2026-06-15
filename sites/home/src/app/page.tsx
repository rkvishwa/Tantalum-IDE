import type { Metadata } from "next";
import Link from "next/link";
import Terminal from "@/components/Terminal";
import ScrollIndicator from "@/components/ScrollIndicator";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { featuredProjects, upcomingProjects } from "@/data/projects";
import { partners } from "@/data/partners";

const BASE_URL = "https://knurdz.org";

export const metadata: Metadata = {
  alternates: { canonical: BASE_URL },
};

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Knurdz",
  alternateName: "Knurdz Community",
  url: BASE_URL,
  logo: `${BASE_URL}/logo/knurdz-logo-horizontal-light-bg.png`,
  description:
    "From code to silicon and social impact. A tech community building open-source projects that matter.",
  email: "support@knurdz.org",
  foundingDate: "2025",
  sameAs: ["https://github.com/knurdz"],
  contactPoint: {
    "@type": "ContactPoint",
    email: "support@knurdz.org",
    contactType: "Customer Support",
  },
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      {/* Custom Scroll Indicator - Git Branch Style */}
      <ScrollIndicator />

      {/* Navigation */}
      <Navbar activePage="home" />

      {/* Hero Section */}
      <section
        id="hero"
        className="relative min-h-[calc(100vh-80px)] md:min-h-screen flex items-center justify-center px-6 pt-20"
      >
        <div className="container mx-auto max-w-7xl">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            {/* Left Content */}
            <div className="space-y-8 text-center lg:text-left">
              <div className="inline-block">
                <span className="px-4 py-2 rounded border border-border text-muted text-sm mono-font">
                  $ ./welcome --community
                </span>
              </div>
              <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold leading-tight mono-font">
                <span className="text-foreground">Build.</span>
                <br />
                <span className="text-faded">Innovate.</span>
                <br />
                <span className="text-foreground">
                  Together<span className="text-green-500">.</span>
                </span>
              </h1>
              <p className="text-xl md:text-2xl text-muted max-w-2xl leading-relaxed mx-auto lg:mx-0">
                A community of creators building extraordinary experiences across the stack. From silicon to software and social impact—fork, commit, deploy.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start mono-font text-sm">
                <Link href="/projects" className="px-8 py-4 rounded bg-foreground text-background hover:opacity-90 transition-all font-semibold text-center">
                  git clone projects
                </Link>
                <Link href="/about" className="px-8 py-4 rounded border-2 border-border hover:border-foreground transition-all font-semibold text-foreground text-center">
                  man knurdz
                </Link>
              </div>
            </div>
            {/* Right Visual: Terminal-like */}
            <div className="relative hidden lg:block">
              <Terminal />
            </div>
          </div>
        </div>
      </section>

      {/* Projects Section */}
      <section id="projects" className="relative py-16 md:py-32 px-6">
        <div className="container mx-auto max-w-7xl">
          {/* Section Header */}
          <div className="text-center mb-12 md:mb-20">
            <span className="px-4 py-2 rounded border border-border text-muted text-sm mono-font">
              $ git log --graph --all
            </span>
            <h2 className="text-4xl md:text-6xl font-bold mt-6 mb-4 mono-font text-foreground">
              Featured <span className="text-faded">Projects</span>
            </h2>
            <p className="text-xl text-muted max-w-2xl mx-auto">
              Our repository of innovative solutions and shipped features
            </p>
          </div>

          {/* Git Branch Visualization - Featured */}
          <div className="relative">
            {/* Central Branch Line (SVG) */}
            <div className="hidden lg:block absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2">
              <svg
                className="branch-svg w-full h-full"
                xmlns="http://www.w3.org/2000/svg"
              >
                <line
                  x1="50%"
                  y1="0"
                  x2="50%"
                  y2="100%"
                  strokeWidth="2"
                  className="git-branch-line"
                />
                <circle cx="50%" cy="15%" r="6" fill="#22c55e" className="git-dot" />
                <circle cx="50%" cy="50%" r="6" fill="#22c55e" className="git-dot" style={{ animationDelay: "0.2s" }} />
                <circle cx="50%" cy="85%" r="6" fill="#22c55e" className="git-dot" style={{ animationDelay: "0.4s" }} />
              </svg>
            </div>

            {/* Featured Projects Grid */}
            <div className="space-y-16 lg:space-y-32 relative">
              {featuredProjects.map((project, index) => {
                const isRight = index % 2 === 0;
                const card = (
                  <Link
                    href={`/projects/${project.slug}`}
                    className="group relative bg-card backdrop-blur-xl rounded-lg border border-border overflow-hidden hover:border-foreground/30 transition-all duration-300 p-8 block"
                  >
                    <div className="flex items-start justify-between mb-4">
                      <div className="mono-font text-sm text-muted">
                        <span className="text-green-500">●</span> {project.branch}
                      </div>
                      <span className="text-xs text-faded mono-font">
                        commit {project.commit}
                      </span>
                    </div>
                    <h3 className="text-3xl font-bold mb-3 mono-font hover:opacity-75 transition-opacity text-foreground">
                      {project.name}
                    </h3>
                    <p className="text-muted mb-4">{project.description}</p>
                    <div className="flex flex-wrap gap-2 mb-6">
                      {project.tags.map((tag: string) => (
                        <span
                          key={tag}
                          className="px-3 py-1 rounded border border-border text-muted text-xs mono-font"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div className="text-foreground font-semibold flex items-center gap-2 transition-all mono-font text-sm group-hover:gap-4">
                      git show details →
                    </div>
                  </Link>
                );

                return (
                  <div key={project.name} className="grid lg:grid-cols-2 gap-8 items-center">
                    <div className={`lg:order-1 ${!isRight ? "block" : "hidden lg:block"}`}>
                      {!isRight && card}
                    </div>
                    <div className={`lg:order-2 ${isRight ? "block" : "hidden lg:block"}`}>
                      {isRight && card}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Upcoming Projects */}
          <div className="mt-32">
            <div className="text-center mb-12">
              <span className="px-4 py-2 rounded border border-yellow-500/30 text-yellow-500/80 text-sm mono-font">
                $ git stash list --upcoming
              </span>
              <h2 className="text-3xl md:text-4xl font-bold mt-6 mb-4 mono-font text-foreground">
                Upcoming <span className="text-faded">Projects</span>
              </h2>
              <p className="text-lg text-muted max-w-2xl mx-auto">
                In progress — currently being crafted in our dev branches
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {upcomingProjects.map((project) => (
                <div
                  key={project.name}
                  className="relative bg-card backdrop-blur-xl rounded-lg border border-dashed border-border p-8 opacity-80"
                >
                  {/* Integrated Header: Branch, Badge, Commit */}
                  <div className="flex justify-between items-start mb-2">
                    <div className="mono-font text-sm text-faded flex items-center gap-2">
                      <span className="text-yellow-600">◐</span> {project.branch}
                    </div>
                    <span className="px-2 py-1 rounded text-xs mono-font bg-yellow-500/10 text-yellow-500/80 border border-yellow-500/20 whitespace-nowrap ml-2">
                      // upcoming
                    </span>
                  </div>
                  <div className="text-xs text-muted mono-font mb-4">
                    commit {project.commit}
                  </div>
                  
                  {/* Title Section */}
                  <div className="mb-3">
                    <h3 className="text-2xl font-bold mono-font text-foreground truncate">
                      {project.name}
                    </h3>
                    {(project.slug === "project-titanic" || project.slug === "arduino-remote") && (
                      <div className="mt-2">
                        <span className="inline-block text-xs font-normal mono-font text-faded border border-border rounded px-2 py-0.5 whitespace-nowrap">
                          working title
                        </span>
                      </div>
                    )}
                  </div>
                  <p className="text-muted mb-4 text-sm">{project.description}</p>
                  <div className="flex flex-wrap gap-2">
                    {project.tags.map((tag: string) => (
                      <span
                        key={tag}
                        className="px-3 py-1 rounded border border-border text-faded text-xs mono-font"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Partners Section */}
      <section id="partners" className="relative py-32 px-6 bg-background-alt">
        <div className="container mx-auto max-w-7xl">
          {/* Section Header */}
          <div className="text-center mb-20">
            <span className="px-4 py-2 rounded border border-border text-muted text-sm mono-font">
              $ cat partners.json
            </span>
            <h2 className="text-4xl md:text-6xl font-bold mt-6 mb-4 mono-font text-foreground">
              Our <span className="text-faded">Partners</span>
            </h2>
            <p className="text-xl text-muted max-w-2xl mx-auto">
              Collaborating with industry leaders to ship production-ready solutions
            </p>
          </div>

          {/* Partners Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {partners.map((partner) => (
              <div
                key={partner.name}
                className="group relative bg-card backdrop-blur-xl rounded-lg border border-border hover:border-foreground/30 transition-all duration-300 p-6 md:p-10"
              >
                {/* Logo - Centered at top */}
                <div className="flex justify-center mb-8">
                  <img
                    src={partner.logo}
                    alt={`${partner.name} logo`}
                    className="h-16 md:h-20 w-auto object-contain"
                  />
                </div>

                {/* Partner Info */}
                <div className="text-center mb-6">
                  <h3 className="text-xl md:text-2xl font-bold mono-font text-foreground mb-3">
                    {partner.name}
                  </h3>
                  <p className="text-sm text-muted leading-relaxed mb-4">
                    {partner.description}
                  </p>
                  <a
                    href={partner.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border hover:border-green-500/50 hover:bg-green-500/5 transition-all text-sm mono-font text-muted hover:text-green-500"
                  >
                    <span>Visit Website</span>
                    <span>↗</span>
                  </a>
                </div>

                {/* Projects Section */}
                <div className="mt-8 pt-6 border-t border-border">
                  <div className="flex items-center gap-2 mb-6">
                    <span className="text-xs mono-font text-muted uppercase tracking-wider">
                      Projects ({partner.projects.length})
                    </span>
                    <div className="flex-1 h-px bg-card"></div>
                  </div>
                  <div className="space-y-3">
                    {partner.projects.map((project) => {
                      const statusConfig = {
                        live: {
                          color: "text-green-500",
                          bg: "bg-green-500/10",
                          border: "border-green-500/30",
                          dotBg: "bg-green-500",
                          label: "Live"
                        },
                        beta: {
                          color: "text-orange-500",
                          bg: "bg-orange-500/10",
                          border: "border-orange-500/30",
                          dotBg: "bg-orange-500",
                          label: "Beta"
                        },
                        development: {
                          color: "text-blue-500",
                          bg: "bg-blue-500/10",
                          border: "border-blue-500/30",
                          dotBg: "bg-blue-500",
                          label: "In Development"
                        },
                        design: {
                          color: "text-purple-500",
                          bg: "bg-purple-500/10",
                          border: "border-purple-500/30",
                          dotBg: "bg-purple-500",
                          label: "In Design"
                        },
                        upcoming: {
                          color: "text-yellow-500",
                          bg: "bg-yellow-500/10",
                          border: "border-yellow-500/30",
                          dotBg: "bg-yellow-500",
                          label: "Upcoming"
                        }
                      };

                      const status = statusConfig[project.status];

                      return (
                        <a
                          key={project.slug}
                          href={project.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group/project block p-4 rounded-lg bg-card border border-border hover:border-green-500/50 hover:bg-green-500/5 transition-all"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex-1">
                              <div className="flex items-center gap-3 mb-1">
                                <h4 className="font-semibold text-muted group-hover/project:text-foreground transition-colors mono-font">
                                  {project.name}
                                </h4>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs mono-font ${status.bg} ${status.border} ${status.color}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${status.dotBg}`}></span>
                                {status.label}
                              </span>
                              <span className="text-faded group-hover/project:text-green-500 transition-colors text-xl">
                                ↗
                              </span>
                            </div>
                          </div>
                        </a>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>

        </div>
      </section>

      {/* CTA Section */}
      <section id="cta" className="relative py-32 px-6">
        <div className="container mx-auto max-w-5xl">
          <div className="relative bg-card rounded-lg border border-border p-8 md:p-20 text-center overflow-hidden">
            <div className="relative z-10 space-y-8">
              <div className="mono-font text-sm text-green-500 mb-4">
                $ ./ready_to_build.sh
              </div>
              <h2 className="text-4xl md:text-6xl font-bold mono-font text-foreground">
                Ready to <span className="text-faded">Create</span>
                <br />
                Something Amazing<span className="text-green-500">?</span>
              </h2>
              <p className="text-xl text-muted max-w-2xl mx-auto">
                Join our community and let&apos;s build the future together
              </p>
              <div className="flex flex-wrap gap-4 justify-center mono-font text-sm">
                <Link href="/projects" className="px-10 py-5 rounded bg-foreground text-background hover:opacity-90 transition-all font-bold">
                  git init project
                </Link>
                <Link href="/contact" className="px-10 py-5 rounded border-2 border-border hover:border-foreground transition-all font-bold text-foreground">
                  curl -X POST /contact
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <Footer />
    </>
  );
}
