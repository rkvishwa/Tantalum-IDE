import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "404 Not Found | Knurdz",
  description: "Page not found in the Knurdz repository.",
};

export default function NotFound() {
  return (
    <>
      <Navbar />
      
      <section className="relative min-h-[calc(100vh-80px)] flex items-center justify-center px-6 pt-20">
        <div className="container mx-auto max-w-4xl text-center">
          <div className="inline-block mb-6">
            <span className="px-4 py-2 rounded border border-red-500/30 text-red-500/80 text-sm mono-font bg-red-500/10">
              $ ping server -c 1
            </span>
          </div>
          
          <h1 className="text-6xl md:text-8xl font-bold leading-tight mono-font mb-6 text-foreground">
            404<span className="text-red-500">_</span>
          </h1>
          <h2 className="text-3xl md:text-4xl font-bold mb-6 mono-font text-faded">
            Page Not Found
          </h2>
          
          <p className="text-xl text-muted mb-12 max-w-2xl mx-auto">
            The requested path does not exist in our repository. It might have been deleted, moved, or never existed.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4 justify-center mono-font text-sm">
            <Link href="/" className="px-8 py-4 rounded bg-foreground text-background hover:opacity-90 transition-all font-semibold text-center mt-4">
              cd ~
            </Link>
            <Link href="/projects" className="px-8 py-4 mt-4 rounded border-2 border-border hover:border-foreground transition-all font-semibold text-foreground text-center">
              ls /projects
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
