import partnersData from "./partners.json";

export interface Partner {
  name: string;
  logo: string;
  website: string;
  description: string;
  projects: {
    name: string;
    slug: string;
    url: string;
    status: "live" | "development" | "design" | "upcoming" | "beta";
  }[];
}

export const partners: Partner[] = partnersData as Partner[];
