"use client";

import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import ScrollIndicator from "@/components/ScrollIndicator";
import { partners } from "@/data/partners";
import Link from "next/link";

export default function PartnersPage() {
  return (
    <>
      <Navbar activePage="partners" />
      <ScrollIndicator />

      <div className="pt-32 pb-20">
        {/* Partners Section */}
        <section id="partners" className="relative px-6">
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
                Collaborating with industry leaders to ship production-ready
                solutions
              </p>
            </div>

            {/* Partners Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {partners.map((partner) => (
                <div
                  key={partner.name}
                  className="group relative bg-card backdrop-blur-xl rounded-lg border border-border hover:border-foreground/20 transition-all duration-300 p-6 md:p-10"
                >
                  {/* Logo - Centered at top */}
                  <div className="flex justify-center mb-8">
                    <img
                      src={partner.logo}
                      alt={`${partner.name} logo`}
                      className="h-16 md:h-20 w-auto object-contain"
                    />
                  </div>

                  {/* Partner Details */}
                  <div className="text-center mb-6">
                    <h3 className="text-xl md:text-2xl font-bold mb-2 mono-font text-foreground">
                      {partner.name}
                    </h3>
                    <Link
                      href={partner.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-green-500 hover:text-green-400 text-sm mono-font transition-colors break-all"
                    >
                      {partner.website.replace("https://", "")} ↗
                    </Link>
                  </div>

                  <p className="text-muted text-center mb-8 leading-relaxed">
                    {partner.description}
                  </p>

                  {/* Collaboration Projects */}
                  <div>
                    <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-4 mono-font text-center">
                       collaborations //
                    </h4>
                    <div className="space-y-3">
                      {partner.projects.map((project) => (
                        <div
                          key={project.name}
                          className="flex items-center justify-between p-3 rounded bg-background-alt border border-border hover:border-foreground/10 transition-colors"
                        >
                          <Link 
                            href={project.url}
                            rel="noopener noreferrer"
                            target="_blank" className="font-medium text-foreground"
                          >
                            {project.name}
                          </Link>
                          <span
                            className={`text-xs px-2 py-1 rounded mono-font ${
                              project.status === "live"
                                ? "bg-green-500/10 text-green-500"
                                : project.status === "development"
                                ? "bg-blue-500/10 text-blue-500"
                                : "bg-yellow-500/10 text-yellow-500"
                            }`}
                          >
                            {project.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <Footer />
    </>
  );
}
