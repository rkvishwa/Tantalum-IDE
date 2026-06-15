import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getProjectBySlug, getAllProjectSlugs } from "@/lib/projects";
import Logo from "@/components/LogoIcon"
import BannerImage from "@/components/BannerImage";
import React from 'react'

import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

interface ArchitectureBox {
  title: string;
  subtitle: string;
}

interface ArchitectureConnection {
  label?: string;
}

function parseArchitectureDiagram(text: string): { boxes: ArchitectureBox[]; connections: ArchitectureConnection[] } | null {
  // Check if this looks like an architecture diagram (contains box-drawing chars)
  if (!text.includes('┌') && !text.includes('│')) return null;

  const lines = text.split('\n');
  const boxes: ArchitectureBox[] = [];
  const connections: ArchitectureConnection[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Detect box start
    if (line.includes('┌')) {
      // Next two lines should be title and subtitle
      const titleLine = lines[i + 1] || '';
      const subtitleLine = lines[i + 2] || '';

      // Extract text between │ characters
      const titleMatch = titleLine.match(/│(.+)│/);
      const subtitleMatch = subtitleLine.match(/│(.+)│/);

      if (titleMatch) {
        boxes.push({
          title: titleMatch[1].trim(),
          subtitle: subtitleMatch ? subtitleMatch[1].trim() : '',
        });
      }
      i += 4; // Skip past the box (top, title, subtitle, bottom)
      continue;
    }

    // Detect connection labels (text between boxes)
    if (line.includes('│') && !line.includes('┌') && !line.includes('└')) {
      const labelMatch = line.match(/│\s*(.+)/);
      if (labelMatch && labelMatch[1].trim() && !labelMatch[1].includes('│')) {
        connections.push({ label: labelMatch[1].trim() });
      }
    }

    i++;
  }

  return boxes.length > 0 ? { boxes, connections } : null;
}

function ArchitectureDiagram({ boxes, connections }: { boxes: ArchitectureBox[]; connections: ArchitectureConnection[] }) {
  return (
    <div className="my-8 flex flex-col items-center gap-0">
      {boxes.map((box, index) => (
        <React.Fragment key={index}>
          {/* Box */}
          <div className="relative w-full max-w-sm">
            <div className="relative bg-card border border-border rounded-lg p-4 backdrop-blur-sm shadow-sm">
              {/* Corner accents */}
              <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-green-500/60 rounded-tl-lg" />
              <div className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-green-500/60 rounded-tr-lg" />
              <div className="absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-green-500/60 rounded-bl-lg" />
              <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-green-500/60 rounded-br-lg" />

              <div className="text-center">
                <div className="text-foreground font-medium mono-font text-sm">{box.title}</div>
                {box.subtitle && (
                  <div className="text-muted text-xs mono-font mt-1">{box.subtitle}</div>
                )}
              </div>
            </div>
          </div>

          {/* Connection arrow (if not last box) */}
          {index < boxes.length - 1 && (
            <div className="flex flex-col items-center py-2">
              <div className="w-px h-4 bg-linear-to-b from-green-500/60 to-green-500/30" />
              {connections[index]?.label && (
                <div className="text-xs text-muted mono-font py-1 px-2">{connections[index].label}</div>
              )}
              <div className="w-px h-4 bg-linear-to-b from-green-500/30 to-green-500/60" />
              <div className="text-green-500 text-sm">▼</div>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  const slugs = getAllProjectSlugs();
  return slugs.map((slug) => ({ slug }));
}

const BASE_URL = "https://knurdz.org";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const project = getProjectBySlug(slug);
  if (!project) return { title: "Project Not Found" };

  const { frontmatter } = project;
  const url = `${BASE_URL}/projects/${slug}`;
  const hasBanner = Boolean(frontmatter.banner);
  const image = hasBanner
    ? `${BASE_URL}${frontmatter.banner}`
    : `${BASE_URL}/logo/knurdz-logo-horizontal.png`;
  const imageWidth = hasBanner ? 1200 : 600;
  const imageHeight = hasBanner ? 630 : 200;

  return {
    title: frontmatter.title,
    description: frontmatter.description,
    alternates: { canonical: url },
    openGraph: {
      title: `${frontmatter.title} — Knurdz`,
      description: frontmatter.description,
      url,
      siteName: "Knurdz",
      type: "article",
      images: [{ url: image, width: imageWidth, height: imageHeight, alt: frontmatter.title }],
    },
    twitter: {
      card: hasBanner ? "summary_large_image" : "summary",
      title: `${frontmatter.title} — Knurdz`,
      description: frontmatter.description,
      images: [image],
    },
  };
}

export default async function ProjectPage({ params }: PageProps) {
  const { slug } = await params;
  const project = getProjectBySlug(slug);
  if (!project) notFound();

  const { frontmatter, content } = project;
  const url = `${BASE_URL}/projects/${slug}`;
  const image = frontmatter.banner
    ? `${BASE_URL}${frontmatter.banner}`
    : `${BASE_URL}/logo/knurdz-logo-horizontal.png`;

  const softwareAppJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: frontmatter.title,
    description: frontmatter.description,
    url,
    image,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    keywords: frontmatter.tags?.join(", "),
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: {
      "@type": "Organization",
      name: "Knurdz",
      url: BASE_URL,
    },
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: BASE_URL },
      { "@type": "ListItem", position: 2, name: "Projects", item: `${BASE_URL}/projects` },
      { "@type": "ListItem", position: 3, name: frontmatter.title, item: url },
    ],
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareAppJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      {/* Navigation */}
      <Navbar activePage="projects" />

      {/* Banner */}
      <div className="relative w-full h-[55vh] min-h-80 mt-0 overflow-hidden">
        <div className="absolute inset-0 bg-linear-to-b from-transparent via-background/40 to-background z-10" />
        
        {frontmatter.banner ? (
          <BannerImage 
            srcDark={frontmatter.banner}
            srcLight={frontmatter.bannerLight}
            title={frontmatter.title}
          />
        ) : (
          <div className="absolute inset-0 bg-card">
            <div className="absolute inset-0">
              {/* Fallback pattern if image missing */}
              <div
                className="absolute inset-0 opacity-[0.08]"
                style={{
                  backgroundImage:
                    "linear-gradient(var(--foreground) 1px, transparent 1px), linear-gradient(90deg, var(--foreground) 1px, transparent 1px)",
                  backgroundSize: "40px 40px",
                }}
              />
            </div>
            <div className="absolute inset-0 flex items-center justify-center opacity-20 grayscale">
              <Logo />
            </div>
          </div>
        )}
      </div>

      {/* Header */}
      <div className="relative -mt-24 z-20 container mx-auto max-w-4xl px-6 pb-4">
        <div className="mb-6 flex flex-wrap items-center gap-3 mono-font text-sm">
          <span className="text-green-500">●</span>
          <span className="text-muted">{frontmatter.branch}</span>
          <span className="text-faded">·</span>
          <span className="text-faded">commit {frontmatter.commit}</span>
        </div>

        <h1 className="text-4xl md:text-6xl font-bold mono-font mb-4 text-foreground">
          {frontmatter.title}
        </h1>
        <p className="text-xl text-muted mb-6 max-w-2xl">
          {frontmatter.description}
        </p>

        <div className="flex flex-wrap gap-2">
          {frontmatter.tags?.map((tag) => (
            <span
              key={tag}
              className="px-3 py-1 rounded border border-border text-muted text-xs mono-font bg-background-alt"
            >
              {tag}
            </span>
          ))}
        </div>

        <div className="mt-8 border-t border-border" />
      </div>

      {/* Markdown Content */}
      <article className="container mx-auto max-w-4xl px-6 pb-32">
        <div className="project-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h2: ({ children }) => (
                <h2 className="text-2xl md:text-3xl font-bold mono-font mt-12 mb-4 text-foreground">
                  {children}
                </h2>
              ),
              h3: ({ children }) => (
                <h3 className="text-xl font-semibold mono-font mt-8 mb-3 text-foreground">
                  {children}
                </h3>
              ),
              p: ({ children }) => (
                <p className="text-muted leading-relaxed mb-5 text-lg">
                  {children}
                </p>
              ),
              code: ({ children, className }) => {
                const isInline = !className;
                return isInline ? (
                  <code className="bg-muted/20 text-green-400 dark:text-green-400 mono-font text-sm px-2 py-0.5 rounded">
                    {children}
                  </code>
                ) : (
                  <code
                    style={{
                      display: 'block',
                      fontFamily: 'inherit',
                      fontSize: 'inherit',
                      lineHeight: 'inherit',
                      letterSpacing: 'inherit',
                    }}
                  >
                    {children}
                  </code>
                );
              },
              pre: ({ children }) => {
                // Extract text content from children
                const getTextContent = (node: React.ReactNode): string => {
                  if (typeof node === 'string') return node;
                  if (Array.isArray(node)) return node.map(getTextContent).join('');
                  if (React.isValidElement(node)) {
                    const props = node.props as { children?: React.ReactNode };
                    if (props.children) {
                      return getTextContent(props.children);
                    }
                  }
                  return '';
                };

                const text = getTextContent(children);
                const architectureData = parseArchitectureDiagram(text);

                if (architectureData) {
                  return <ArchitectureDiagram boxes={architectureData.boxes} connections={architectureData.connections} />;
                }

                return (
                  <pre
                    className="bg-card border border-border rounded-lg p-6 overflow-x-auto mb-8 text-green-600 dark:text-green-400"
                    style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
                      fontSize: '14px',
                      lineHeight: 1.6,
                      letterSpacing: 0,
                      fontFeatureSettings: 'normal',
                      fontVariantLigatures: 'none',
                      whiteSpace: 'pre',
                      tabSize: 4,
                    }}
                  >
                    {children}
                  </pre>
                );
              },
              ul: ({ children }) => (
                <ul className="space-y-2 mb-6 list-none pl-0">{children}</ul>
              ),
              li: ({ children }) => (
                // Note: changed text-muted for the items
                <li className="text-muted flex items-start gap-3 leading-relaxed">
                  <span className="text-green-500 shrink-0">▸</span>
                  <span className="display-flex items-center gap-2">{children}</span>
                </li>
              ),
              strong: ({ children }) => (
                <strong className="text-foreground font-semibold">{children}</strong>
              ),
              table: ({ children }) => (
                <div className="overflow-x-auto mb-6">
                  <table className="w-full border-collapse mono-font text-sm">
                    {children}
                  </table>
                </div>
              ),
              thead: ({ children }) => (
                <thead className="border-b border-border">{children}</thead>
              ),
              th: ({ children }) => (
                <th className="text-left py-2 px-4 text-foreground font-semibold">
                  {children}
                </th>
              ),
              td: ({ children }) => (
                // Note: changed border-border
                <td className="py-2 px-4 text-muted border-b border-border/50">
                  {children}
                </td>
              ),
              blockquote: ({ children }) => (
                <blockquote className="border-l-4 border-green-500 pl-6 my-6 text-muted italic">
                  {children}
                </blockquote>
              ),
              hr: () => <hr className="border-border my-10" />,
              a: ({ href, children }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-2 px-2 md:px-4 bg-green-500/10 hover:bg-green-500/20 border border-green-500/30 hover:border-green-500 text-green-400 dark:text-green-400 hover:text-green-500 rounded-lg mono-font text-xs md:text-sm transition-all duration-200 no-underline word-break whitespace-normal"
                >
                  <span className="truncate">{children}</span>
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6V8H5V19H16V14H18V20C18 20.5523 17.5523 21 17 21H4C3.44772 21 3 20.5523 3 20V7C3 6.44772 3.44772 6 4 6H10ZM21 3V12L17.206 8.207L11.2071 14.2071L9.79289 12.7929L15.792 6.793L12 3H21Z"></path></svg>
                </a>
              ),
              img: ({ src, alt }) => (
                <div className="relative w-full aspect-video my-8 rounded-lg overflow-hidden border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={typeof src === "string" ? src : ""}
                    alt={alt || ""}
                    className="w-full h-full object-cover"
                  />
                </div>
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      </article>

      <Footer />
    </div>
  );
}
