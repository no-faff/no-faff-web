export type ProjectStatus = 'shipped' | 'in-development' | 'planning';
export type ProjectTier = 1 | 2;

export interface Project {
  slug: string;
  name: string;
  tier: ProjectTier;
  status: ProjectStatus;
  oneLiner: string;
  homepage: string;
  github: string;
}

export const projects: Project[] = [
  {
    slug: 'installerclean',
    name: 'InstallerClean',
    tier: 1,
    status: 'shipped',
    oneLiner: 'Safely clean up the hidden Windows folder that quietly eats your disk space.',
    homepage: '/installerclean',
    github: 'https://github.com/no-faff/InstallerClean',
  },
  {
    slug: 'silo',
    name: 'Silo',
    tier: 1,
    status: 'shipped',
    oneLiner: 'A browser picker for Linux that routes links to the right browser and profile.',
    homepage: '/silo',
    github: 'https://github.com/no-faff/Silo',
  },
  {
    slug: 'cookie-jar',
    name: 'Cookie Jar',
    tier: 1,
    status: 'in-development',
    oneLiner:
      'A Firefox extension that auto-deletes cookies when tabs close, except for sites you trust.',
    homepage: '/cookie-jar',
    github: 'https://github.com/no-faff/Cookie-Cull',
  },
  {
    slug: 'simple-video-downloader',
    name: 'Simple Video Downloader',
    tier: 1,
    status: 'shipped',
    oneLiner: 'Download videos and audio inside Firefox, powered by yt-dlp.',
    homepage: '/simple-video-downloader',
    github: 'https://github.com/FarmLox/Simple-video-downloader',
  },
  {
    slug: 'ulauncher',
    name: 'Ulauncher extensions',
    tier: 2,
    status: 'shipped',
    oneLiner: 'Four small Ulauncher extensions: yt-dlp, file find, dictionary, calculator.',
    homepage: '/ulauncher',
    github: 'https://github.com/no-faff',
  },
];

export function getProject(slug: string): Project | undefined {
  return projects.find((p) => p.slug === slug);
}
