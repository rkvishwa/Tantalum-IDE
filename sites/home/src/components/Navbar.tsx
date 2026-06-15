"use client";

import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import { useEffect, useState } from "react";

interface NavbarProps {
  activePage?: "home" | "projects" | "partners" | "about" | "contact";
}

export default function Navbar({ activePage }: NavbarProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Prevent scrolling when menu is open
  useEffect(() => {
    if (isMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }
  }, [isMenuOpen]);

  return (
    <>
      <nav className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between relative">
          <Link
            href="/"
            aria-label="Knurdz home"
            className="flex items-center gap-3 hover:opacity-80 transition-opacity z-10 relative"
            onClick={() => setIsMenuOpen(false)}
          >
            <img
              src="/logo/knurdz-logo-horizontal.png"
              alt=""
              aria-hidden="true"
              className="logo-dark block h-11 md:h-12 w-auto transition-transform"
            />
            <img
              src="/logo/knurdz-logo-horizontal-light.png"
              alt=""
              aria-hidden="true"
              className="logo-light block h-11 md:h-12 w-auto transition-transform"
            />
          </Link>
          
          {/* Desktop Navigation */}
          <div className="hidden lg:flex items-center gap-8">
            <Link
              href="/"
              className={`${
                activePage === "home" ? "text-foreground" : "text-muted"
              } hover:text-foreground transition-colors mono-font text-sm`}
            >
              /home
            </Link>
            <Link
              href="/projects"
              className={`${
                activePage === "projects" ? "text-foreground" : "text-muted"
              } hover:text-foreground transition-colors mono-font text-sm`}
            >
              /projects
            </Link>
            <Link
              href="/partners"
              className={`${
                activePage === "partners" ? "text-foreground" : "text-muted"
              } hover:text-foreground transition-colors mono-font text-sm`}
            >
              /partners
            </Link>
            <Link
              href="/about"
              className={`${
                activePage === "about" ? "text-foreground" : "text-muted"
              } hover:text-foreground transition-colors mono-font text-sm`}
            >
              /about
            </Link>
            <ThemeToggle />
            <Link
              href="/contact"
              className={`${
                activePage === "contact"
                  ? "bg-foreground text-background hover:opacity-90"
                  : "border border-foreground hover:bg-foreground hover:text-background"
              } px-6 py-2 rounded transition-all font-medium mono-font text-sm`}
            >
              % cd contact
            </Link>
          </div>

          {/* Mobile Menu Button */}
          <button
            type="button"
            className="lg:hidden p-3 text-foreground z-60 touch-manipulation min-w-12 min-h-12 flex items-center justify-center active:opacity-70"
            onClick={(e) => {
              e.stopPropagation();
              setIsMenuOpen(!isMenuOpen);
            }}
            aria-label="Toggle menu"
            aria-expanded={isMenuOpen}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <div className="w-6 h-5 relative">
              <span
                className={`absolute left-0 h-0.5 w-full bg-current transition-all duration-300 ease-in-out transform origin-center pointer-events-none ${
                  isMenuOpen ? "top-1/2 -translate-y-1/2 rotate-45" : "top-0"
                }`}
              />
              <span
                className={`absolute left-0 top-1/2 -translate-y-1/2 h-0.5 w-full bg-current transition-all duration-300 ease-in-out pointer-events-none ${
                  isMenuOpen ? "opacity-0" : "opacity-100"
                }`}
              />
              <span
                className={`absolute left-0 h-0.5 w-full bg-current transition-all duration-300 ease-in-out transform origin-center pointer-events-none ${
                  isMenuOpen ? "top-1/2 -translate-y-1/2 -rotate-45" : "bottom-0"
                }`}
              />
            </div>
          </button>
        </div>
      </nav>

      {/* Mobile Menu Dropdown */}
      <div 
        className={`lg:hidden fixed top-20 left-0 w-full bg-background/95 backdrop-blur-xl border-b border-border shadow-2xl z-40 transition-all duration-300 ease-in-out transform origin-top ${
          isMenuOpen 
            ? "translate-y-0 opacity-100 scale-y-100 visible" 
            : "-translate-y-4 opacity-0 scale-y-95 invisible pointer-events-none"
        }`}
      >
        <div className="container mx-auto px-6 py-6 flex flex-col gap-2">
          <Link
            href="/"
            onClick={() => setIsMenuOpen(false)}
            className={`group py-3 px-4 rounded-lg transition-all duration-200 mono-font flex items-center justify-between ${
              activePage === "home" 
                ? "bg-foreground text-background" 
                : "text-foreground hover:bg-muted/10 border border-transparent hover:border-border"
            }`}
          >
            <span className="flex items-center gap-3">
              <span className={`text-xs ${activePage === "home" ? "text-background/60" : "text-muted"}`}>01.</span> 
              /home
            </span>
            {activePage === "home" && <span className="text-xs">●</span>}
          </Link>

          <Link
            href="/projects"
            onClick={() => setIsMenuOpen(false)}
            className={`group py-3 px-4 rounded-lg transition-all duration-200 mono-font flex items-center justify-between ${
              activePage === "projects" 
                ? "bg-foreground text-background" 
                : "text-foreground hover:bg-muted/10 border border-transparent hover:border-border"
            }`}
          >
            <span className="flex items-center gap-3">
              <span className={`text-xs ${activePage === "projects" ? "text-background/60" : "text-muted"}`}>02.</span> 
              /projects
            </span>
            {activePage === "projects" && <span className="text-xs">●</span>}
          </Link>

          <Link
            href="/partners"
            onClick={() => setIsMenuOpen(false)}
            className={`group py-3 px-4 rounded-lg transition-all duration-200 mono-font flex items-center justify-between ${
              activePage === "partners" 
                ? "bg-foreground text-background" 
                : "text-foreground hover:bg-muted/10 border border-transparent hover:border-border"
            }`}
          >
            <span className="flex items-center gap-3">
              <span className={`text-xs ${activePage === "partners" ? "text-background/60" : "text-muted"}`}>03.</span> 
              /partners
            </span>
            {activePage === "partners" && <span className="text-xs">●</span>}
          </Link>
          
          <Link
            href="/about"
            onClick={() => setIsMenuOpen(false)}
            className={`group py-3 px-4 rounded-lg transition-all duration-200 mono-font flex items-center justify-between ${
              activePage === "about" 
                ? "bg-foreground text-background" 
                : "text-foreground hover:bg-muted/10 border border-transparent hover:border-border"
            }`}
          >
            <span className="flex items-center gap-3">
              <span className={`text-xs ${activePage === "about" ? "text-background/60" : "text-muted"}`}>04.</span> 
              /about
            </span>
            {activePage === "about" && <span className="text-xs">●</span>}
          </Link>
          
          <div className="h-px bg-border my-3 mx-2"></div>
          
          <div className="flex items-center justify-between px-4 py-2 mb-2">
            <span className="text-sm mono-font text-muted">Appearance</span>
            <ThemeToggle />
          </div>

          <Link
            href="/contact"
            onClick={() => setIsMenuOpen(false)}
            className={`mt-1 w-full text-center py-4 rounded-lg font-bold mono-font transition-all border-2 ${
              activePage === "contact"
                ? "bg-foreground text-background border-foreground"
                : "border-foreground text-foreground hover:bg-foreground hover:text-background"
            }`}
          >
            % cd contact_us
          </Link>
        </div>
      </div>
    </>
  );
}
