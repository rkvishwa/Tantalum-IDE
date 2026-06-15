import fs from "fs";
import path from "path";
import matter from "gray-matter";

const CONTENT_DIR = path.join(process.cwd(), "src/content/projects");

export interface ProjectMatter {
  title: string;
  banner: string;
  bannerLight?: string;
  description: string;
  tags: string[];
  branch: string;
  commit: string;
  license?: string;
}

export interface ProjectContent {
  frontmatter: ProjectMatter;
  content: string;
}

export function getProjectBySlug(slug: string): ProjectContent | null {
  const filePath = path.join(CONTENT_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);

  return {
    frontmatter: data as ProjectMatter,
    content,
  };
}

export function getAllProjectSlugs(): string[] {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  return fs
    .readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""));
}
