"use client";

import Link from "next/link";
import { useState } from "react";
import ScrollIndicator from "@/components/ScrollIndicator";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

type FormState = "idle" | "sending" | "success" | "error";

export default function ContactPage() {
  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" });
  const [status, setStatus] = useState<FormState>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("sending");
    setErrorMsg("");

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        setStatus("success");
        setForm({ name: "", email: "", subject: "", message: "" });
      } else {
        const data = await res.json();
        setErrorMsg(data.error ?? "Unknown error");
        setStatus("error");
      }
    } catch {
      setErrorMsg("Network error. Please try again.");
      setStatus("error");
    }
  };

  return (
    <>
      <ScrollIndicator />

      {/* Navigation */}
      <Navbar activePage="contact" />

      <main className="min-h-screen pt-32 pb-20 px-6">
        <div className="container mx-auto max-w-6xl">

          {/* Header */}
          <div className="mb-16 text-center lg:text-left">
            <span className="inline-block px-4 py-2 rounded border border-border text-muted text-sm mono-font mb-6">
              $ curl -X POST /contact --data &apos;{`{}`}&apos;
            </span>
            <h1 className="text-5xl md:text-7xl font-bold mono-font leading-tight">
              <span className="text-foreground">Get in</span>{" "}
              <span className="text-faded">Touch</span>
              <span className="text-green-500">.</span>
            </h1>
            <p className="mt-4 text-xl text-muted max-w-xl">
              Open a new issue — let&apos;s build something together.
            </p>
          </div>

          <div className="grid lg:grid-cols-5 gap-12">

            {/* Left — Info Panel */}
            <div className="lg:col-span-2 space-y-6">

              {/* Connection info card */}
              <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                <p className="mono-font text-xs text-muted mb-2">// connection.config</p>

                <div className="space-y-4">
                  <InfoRow icon="✉" label="email" value="hello@knurdz.org" href="mailto:hello@knurdz.org" />
                  <InfoRow icon="🔗" label="linkedin" value="/company/knurdz" href="https://linkedin.com/company/knurdz" />
                  <InfoRow icon="🐙" label="github" value="github.com/knurdz" href="https://github.com/knurdz" />
                  <InfoRow icon="𝕏" label="X (Twitter)" value="@knurdz_org" href="https://x.com/knurdz_org" />
                  <InfoRow icon="📸" label="instagram" value="@knurdz_org" href="https://www.instagram.com/knurdz_org" />
                  <InfoRow icon="📘" label="facebook" value="@knurdz" href="https://www.facebook.com/share/1AjqzPjqFa/" />
                  <InfoRow icon="🎬" label="tiktok" value="@knurdz_org" href="https://www.tiktok.com/@knurdz_org" />
                  <InfoRow icon="▶️" label="youtube" value="@Knurdz" href="https://www.youtube.com/@knurdz" />
                </div>
              </div>

              {/* Response time card */}
              <div className="bg-card border border-border rounded-lg p-6">
                <p className="mono-font text-xs text-muted mb-3">// process.status</p>
                <div className="flex items-center gap-3 mb-3">
                  <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                  <span className="mono-font text-sm text-green-500">online &amp; available</span>
                </div>
                <p className="text-muted text-sm">
                  We typically respond within <span className="text-foreground font-semibold">24 hours</span>.
                </p>
              </div>

              {/* Services card */}
              <div className="bg-card border border-border rounded-lg p-6">
                <p className="mono-font text-xs text-muted mb-4">// services.list</p>
                <ul className="space-y-2">
                  {["Web Development", "Mobile Apps", "Desktop Application", "UI/UX Design", "AI Integration", "Consulting"].map((s) => (
                    <li key={s} className="flex items-center gap-2 mono-font text-sm text-foreground">
                      <span className="text-green-500">›</span> {s}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Right — Contact Form */}
            <div className="lg:col-span-3">
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                {/* Terminal title bar */}
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-background-alt">
                  <span className="w-3 h-3 rounded-full bg-red-500/70" />
                  <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
                  <span className="w-3 h-3 rounded-full bg-green-500/70" />
                  <span className="ml-3 mono-font text-xs text-muted">new-issue.sh</span>
                </div>

                <form onSubmit={handleSubmit} className="p-8 space-y-6">
                  {/* Name + Email */}
                  <div className="grid sm:grid-cols-2 gap-6">
                    <Field
                      label="name"
                      name="name"
                      type="text"
                      placeholder="John Doe"
                      value={form.name}
                      onChange={handleChange}
                      required
                    />
                    <Field
                      label="email"
                      name="email"
                      type="email"
                      placeholder="john@example.com"
                      value={form.email}
                      onChange={handleChange}
                      required
                    />
                  </div>

                  {/* Subject */}
                  <div className="space-y-2">
                    <label className="mono-font text-xs text-muted">
                      <span className="text-green-500">$</span> --subject
                    </label>
                    <select
                      name="subject"
                      value={form.subject}
                      onChange={handleChange}
                      required
                      className="w-full bg-background-alt border border-border rounded px-4 py-3 mono-font text-sm text-foreground focus:outline-none focus:border-green-500/50 transition-colors"
                    >
                      <option value="" className="bg-card text-foreground">Select a topic...</option>
                      <option value="project" className="bg-card text-foreground">New Project</option>
                      <option value="collaboration" className="bg-card text-foreground">Collaboration</option>
                      <option value="consulting" className="bg-card text-foreground">Consulting</option>
                      <option value="general" className="bg-card text-foreground">General Inquiry</option>
                      <option value="other" className="bg-card text-foreground">Other</option>
                    </select>
                  </div>

                  {/* Message */}
                  <div className="space-y-2">
                    <label className="mono-font text-xs text-muted">
                      <span className="text-green-500">$</span> --message
                    </label>
                    <textarea
                      name="message"
                      value={form.message}
                      onChange={handleChange}
                      required
                      rows={6}
                      placeholder="Describe your project or inquiry..."
                      className="w-full bg-background-alt border border-border rounded px-4 py-3 mono-font text-sm text-foreground placeholder-muted/50 focus:outline-none focus:border-green-500/50 transition-colors resize-none"
                    />
                  </div>

                  {/* Status messages */}
                  {status === "success" && (
                    <div className="flex items-center gap-3 px-4 py-3 rounded border border-green-500/30 bg-green-500/10 mono-font text-sm text-green-400">
                      <span>✓</span>
                      <span>Message sent! We&apos;ll be in touch shortly.</span>
                    </div>
                  )}
                  {status === "error" && (
                    <div className="flex items-center gap-3 px-4 py-3 rounded border border-red-500/30 bg-red-500/10 mono-font text-sm text-red-400">
                      <span>✗</span>
                      <span>{errorMsg || "Something went wrong. Please try again."}</span>
                    </div>
                  )}

                  {/* Submit */}
                  <button
                    type="submit"
                    disabled={status === "sending"}
                    className="w-full py-4 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-bold mono-font text-sm flex items-center justify-center gap-2"
                  >
                    {status === "sending" ? (
                      <>
                        <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                        sending...
                      </>
                    ) : (
                      <span>git commit -m &quot;new inquiry&quot;</span>
                    )}
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <Footer />
    </>
  );
}

// ── Small helpers ──────────────────────────────────────────────

function Field({
  label,
  name,
  type,
  placeholder,
  value,
  onChange,
  required,
}: {
  label: string;
  name: string;
  type: string;
  placeholder: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
}) {
  return (
    <div className="space-y-2">
      <label className="mono-font text-xs text-muted">
        <span className="text-green-500">$</span> --{label}
      </label>
      <input
        type={type}
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        required={required}
        className="w-full bg-background-alt border border-border rounded px-4 py-3 mono-font text-sm text-foreground placeholder-muted/50 focus:outline-none focus:border-green-500/50 transition-colors"
      />
    </div>
  );
}

function InfoRow({
  icon,
  label,
  value,
  href,
  disabled,
}: {
  icon: string;
  label: string;
  value: string;
  href: string;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <div className="flex items-start gap-3 opacity-40 select-none cursor-not-allowed">
        <span className="text-lg mt-0.5 grayscale">{icon}</span>
        <div>
          <p className="mono-font text-xs text-muted">// {label}</p>
          <p className="mono-font text-sm text-muted">
            {value}
          </p>
        </div>
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-start gap-3 group"
    >
      <span className="text-lg mt-0.5">{icon}</span>
      <div>
        <p className="mono-font text-xs text-muted">// {label}</p>
        <p className="mono-font text-sm text-foreground group-hover:text-green-500 transition-colors">
          {value}
        </p>
      </div>
    </a>
  );
}
