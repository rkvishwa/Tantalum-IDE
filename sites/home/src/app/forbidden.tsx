import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "403 Forbidden | Knurdz",
  description: "Access denied to the Knurdz repository.",
};

export default function Forbidden() {
  return (
    <>
      <Navbar />
      
      <section className="relative min-h-[calc(100vh-80px)] flex items-center justify-center px-6 pt-20">
        <div className="container mx-auto max-w-4xl text-center">
          <div className="inline-block mb-6">
            <span className="px-4 py-2 rounded border border-orange-500/30 text-orange-500/80 text-sm mono-font bg-orange-500/10">
              $ sudo ls /admin
            </span>
          </div>
          
          <h1 className="text-6xl md:text-8xl font-bold leading-tight mono-font mb-6 text-foreground">
            403<span className="text-orange-500">_</span>
          </h1>
          <h2 className="text-3xl md:text-4xl font-bold mb-6 mono-font text-faded">
            Access Denied
          </h2>
          
          <p className="text-xl text-muted mb-12 max-w-2xl mx-auto">
            Permission denied. You do not have the necessary credentials to access this directory.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4 justify-center mono-font text-sm">
            <Link href="/" className="px-8 py-4 rounded bg-foreground text-background hover:opacity-90 transition-all font-semibold text-center mt-4">
              cd ~
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
