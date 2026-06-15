"use client";

import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import ScrollIndicator from "@/components/ScrollIndicator";
import { featuredProjects, upcomingProjects } from "@/data/projects";

export default function ProjectsPage() {
  return (
    <>
      <Navbar activePage="projects" />
      <ScrollIndicator />

      <div className="pt-32 pb-20">
        {/* Projects Section */}
        <section id="projects" className="relative px-6">
          <div className="container mx-auto max-w-7xl">
            {/* Section Header */}
            <div className="text-center mb-20">
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
                  {featuredProjects.map((_, i) => (
                    <circle
                      key={i}
                      cx="50%"
                      cy={`${15 + i * 35}%`} // Approximation of positions
                      r="6"
                      fill="#22c55e"
                      className="git-dot"
                      style={{ animationDelay: `${i * 0.2}s` }}
                    />
                  ))}
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
                          <span className="text-green-500">●</span>{" "}
                          {project.branch}
                        </div>
                        <span className="text-xs text-faded mono-font">
                          commit {project.commit}
                        </span>
                      </div>
                      <h3 className="text-3xl font-bold mb-3 mono-font hover:opacity-75 transition-opacity text-foreground">
                        {project.name}
                      </h3>
                      <p className="text-muted mb-4">
                        {project.description}
                      </p>
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
                    <div
                      key={project.name}
                      className="grid lg:grid-cols-2 gap-8 items-center"
                    >
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
                    className="relative bg-card/40 backdrop-blur-xl rounded-lg border border-dashed border-border p-8 opacity-80"
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
                      {(project.slug === "project-titanic" ||
                        project.slug === "arduino-remote") && (
                        <div className="mt-2">
                          <span className="inline-block text-xs font-normal mono-font text-faded border border-border rounded px-2 py-0.5 whitespace-nowrap">
                            working title
                          </span>
                        </div>
                      )}
                    </div>
                    <p className="text-muted mb-4 text-sm">
                      {project.description}
                    </p>
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
      </div>

      <Footer />
    </>
  );
}
