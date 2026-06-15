export interface Project {
  name: string;
  slug: string;
  branch: string;
  commit: string;
  description: string;
  tags: string[];
  upcoming: boolean;
}

export const projects: Project[] = [
  // ── Featured Projects ──────────────────────────────────────────────────────
  {
    name: "Sonar Code Editor",
    slug: "sonar-code-editor",
    branch: "development",
    commit: "78dc070",
    description:
      "A secure, real-time collaborative coding environment designed specifically for supervised exams and technical interviews.",
    tags: ["Desktop App", "Web"],
    upcoming: false,
  },
  {
    name: "Nothing Dialer 1",
    slug: "nothing-dialer-1",
    branch: "release/beta",
    commit: "1f125a2",
    description:
      "A Dialer app for Nothing OS with custom glyph for outgoing and ongoing calls also.",
    tags: ["Mobile", "IoT"],
    upcoming: false,
  },
  {
    name: "Diss-Master",
    slug: "diss-master",
    branch: "main",
    commit: "da34852",
    description:
      "Diss-Master is a real-time multiplayer word game inspired by Codenames, the beloved board game designed by Vlaada Chvátil and published by Czech Games Edition.",
    tags: ["Web", "Game"],
    upcoming: false,
  },
  {
    name: "Meta Scribe",
    slug: "meta-scribe",
    branch: "main",
    commit: "fbb32e6",
    description:
      "A web-based SEO auditing tool that analyzes metadata, structured data, and on-page content quality to provide actionable optimization recommendations.",
    tags: ["Web App", "SEO", "Developer Tool"],
    upcoming: false,
  },

  // ── Upcoming Projects ──────────────────────────────────────────────────────
  {
    name: "Project Titanic",
    slug: "project-titanic",
    branch: "feature/marketplace",
    commit: "5a2d9c9",
    description:
      "A multipurpose application for university students featuring 6 core distinc features",
    tags: ["Mobile", "Web"],
    upcoming: true,
  },
  {
    name: "Metal PaaS",
    slug: "metal-paas",
    branch: "main",
    commit: "1g6j9c9",
    description:
      "Metal is a high-performance, AI-Native Platform-as-a-Service (PaaS) that revolutionizes how students and developers build for the cloud.",
    tags: ["PaaS", "Infrastructure"],
    upcoming: true,
  },
  {
    name: "Arduino Remote",
    slug: "arduino-remote",
    branch: "development/alpha",
    commit: "4b8e1c5",
    description:
      "Aruido IDE built from scratch powered Arduino CLI with inbuilt cloud based OTA updates and remote debugging.",
    tags: ["Desktop", "IoT"],
    upcoming: true,
  },
];

export const featuredProjects = projects.filter((p) => !p.upcoming);
export const upcomingProjects = projects.filter((p) => p.upcoming);
