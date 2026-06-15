# Projects Portfolio

This file serves as the source of truth for the projects displayed on the Knurdz website. Update this file to add, remove, or modify projects.

## Featured Projects

| Name | Branch | Commit | Description | Tags |
| :-- | :-- | :-- | :-- | :-- |
| Sonar Code Editor | development | 78dc070 | A secure, real-time collaborative coding environment designed specifically for supervised exams and technical interviews. | Desktop App, Web |
| Nothing Dialer 1 | release/beta | 1f125a2 | A Dialer app for Nothing OS with custom glyph for outgoing and ongoing calls also. | Mobile, IoT |
| Diss-Master | main | da34852 | Diss-Master is a real-time multiplayer word game inspired by Codenames, the beloved board game designed by Vlaada Chvátil and published by Czech Games Edition. | Web, Game |
| Meta Scribe | main | fbb32e6 | A web-based SEO auditing tool that analyzes metadata, structured data, and on-page content quality to provide actionable optimization recommendations. | Web App, SEO, Developer Tool |

---

## Upcoming projects

| Name | Branch | Commit | Description | Tags |
| :-- | :-- | :-- | :-- | :-- |
| Project Titanic | feature/marketplace | 5a2d9c9 | A multipurpose application for university students featuring 6 core distinc features | Mobile, Web |
| Metal PaaS | main | 1g6j9c9 | Metal is a high-performance, AI-Native Platform-as-a-Service (PaaS) that revolutionizes how students and developers build for the cloud. | PaaS, Infrastructure |
| Arduino Remote | development/alpha | 4b8e1c5 | Aruido IDE built from scratch powered Arduino CLI with inbuilt cloud based OTA updates and remote debugging. | Desktop, IoT |
---

### Instructions for the AI Agent:
1.  Read this markdown file to get the latest project information.
2.  Update the `src/data/projects.ts` file in the codebase to reflect these changes.
3.  Ensure the `Featured Projects` section in `src/app/page.tsx` correctly renders the updated project data.
4. Also include the upcoming project in same section with some separate label in home page and with separate title in projects.ts file
5. For non upcoming projects only there should be a separate page for each project with detailed description. banner image, title, and blog like content with image and paragraphs formatted. user will place a md file in required place and display that md file as the content. banner, title, content all will be in that md file. for now create sample md files for each projects and place there
