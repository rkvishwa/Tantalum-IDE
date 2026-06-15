export interface Member {
  name: string;
  nickname?: string;
  role: string;
  bio: string;
  image: string;
  github?: string;
  linkedin?: string;
}

export const members: Member[] = [
  {
    name: "RKK Vishva Kumar",
    nickname: "RVK",
    role: "Knurdz Contributor",
    bio: "",
    image: "https://github.com/rkvishwa.png",
    github: "https://github.com/rkvishwa",
    linkedin: "https://www.linkedin.com/in/rkk-vishva/"
  },
  {
    name: "Sadeepa N Herath",
    role: "Knurdz Contributor",
    bio: "",
    image: "https://github.com/SadeepaNHerath.png",
    github: "https://github.com/SadeepaNHerath",
    linkedin: "https://www.linkedin.com/in/sadeepanherath/"
  },
  {
    name: "Kasun Kumara",
    role: "Knurdz Contributor",
    bio: "",
    image: "https://github.com/Kasun-Kumara.png",
    github: "https://github.com/Kasun-Kumara",
    linkedin: "https://www.linkedin.com/in/kasun-kumara-30baaa338/"
  },
  {
    name: "Praveen R",
    role: "Knurdz Contributor",
    bio: "",
    image: "https://github.com/Praveen-R-2518.png",
    github: "https://github.com/Praveen-R-2518",
    linkedin: "https://www.linkedin.com/in/praveen-r-b374612aa/"
  },
  {
    name: "Thesaru Praneeth",
    role: "Knurdz Contributor",
    bio: "",
    image: "https://github.com/Thesaru-p.png",
    github: "https://github.com/Thesaru-p",
    linkedin: "https://www.linkedin.com/in/thesaru-p/"
  },
  {
    name: "Harsha Silva",
    role: "Knurdz Contributor",
    bio: "",
    image: "https://github.com/harshasilva.png",
    github: "https://github.com/harshasilva",
    linkedin: "https://www.linkedin.com/in/harsha-silva-b59776357/"
  },
  {
    name: "Senuka Deneth",
    role: "Knurdz Contributor",
    bio: "",
    image: "https://github.com/Senuka-Deneth.png",
    github: "https://github.com/Senuka-Deneth",
    linkedin: "https://www.linkedin.com/in/senuka-deneth-70937a345/"
  },
  {
    name: "Bhasilu Egodawatte",
    role: "Knurdz Contributor",
    bio: "",
    image: "https://github.com/BhasiluEgodawatte.png",
    github: "https://github.com/BhasiluEgodawatte",
    linkedin: "https://www.linkedin.com/in/bhasilu-egodawatte-79bb70367/"
  },
  {
    name: "Vinuth Karunathilaka",
    role: "Knurdz Contributor",
    bio: "",
    image: "https://github.com/VinuthKarunathilaka.png",
    github: "https://github.com/VinuthKarunathilaka",
    linkedin: "https://www.linkedin.com/in/vinuth-karunathilaka-67160334a/"
  },
  {
    name: "Kaveesha Ginodh",
    role: "Knurdz Member",
    bio: "",
    image: "https://github.com/Kavee-ginty.png",
    github: "https://github.com/Kavee-ginty",
    linkedin: "https://www.linkedin.com/in/kaveesha-ginodh/"
  },
  {
    name: "Ashen Tharindu",
    role: "Knurdz Member",
    bio: "",
    image: "https://github.com/Azriel-prog.png",
    github: "https://github.com/Azriel-prog",
    linkedin: "https://www.linkedin.com/in/ashen-tharindu-041833365/"
  },
  {
    name: "Praveen Fernando",
    role: "Knurdz Member",
    bio: "",
    image: "https://github.com/ARSPFdo-2004.png",
    github: "https://github.com/ARSPFdo-2004",
    linkedin: "https://www.linkedin.com/in/senuka-deneth-70937a345/"
  },
  {
    name: "Mahinsa Waththegedara",
    role: "Knurdz Member",
    bio: "",
    image: "https://github.com/Mahinsa-Wattegedara.png",
    github: "https://github.com/Mahinsa-Wattegedara",
    linkedin: "https://www.linkedin.com/in/mahinsa-waththegedara-28b7b335a/"
  },
  {
    name: "Dasun Jayasanka",
    role: "Knurdz Member",
    bio: "",
    image: "https://github.com/dasunjlk.png",
    github: "https://github.com/dasunjlk",
    linkedin: "https://www.linkedin.com/in/dasunjayasanka/"
  }
];

export interface GalleryImage {
  url: string;
  title: string;
  description: string;
  category: "event" | "project" | "team";
}

export const galleryImages: GalleryImage[] = [
  {
    url: "/gallery/hackathon-2024.jpg",
    title: "Annual Hackathon 2024",
    description: "Our community coming together to build innovative solutions",
    category: "event"
  },
  {
    url: "/gallery/workshop-session.jpg",
    title: "Workshop Session",
    description: "Hands-on coding workshop with community members",
    category: "event"
  },
  {
    url: "/gallery/team-meeting.jpg",
    title: "Team Collaboration",
    description: "Weekly sync discussing upcoming projects",
    category: "team"
  },
  {
    url: "/gallery/project-launch.jpg",
    title: "Project Launch Day",
    description: "Celebrating the successful deployment of our latest project",
    category: "project"
  },
  {
    url: "/gallery/community-event.jpg",
    title: "Community Meetup",
    description: "Monthly community gathering and networking",
    category: "event"
  },
  {
    url: "/gallery/code-review.jpg",
    title: "Code Review Session",
    description: "Collaborative code review and knowledge sharing",
    category: "team"
  }
];
