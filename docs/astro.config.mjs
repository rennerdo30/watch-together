import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightThemeGalaxy from 'starlight-theme-galaxy';

export default defineConfig({
  site: 'https://rennerdo30.github.io',
  base: '/watch-together',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Watch Together',
      description: 'User guides, self-hosting documentation and extension privacy policy',
      plugins: [starlightThemeGalaxy()],
      customCss: ['./src/styles/custom.css'],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/rennerdo30/watch-together' }],
      sidebar: [
        { label: 'Home', slug: 'index' },
        { label: 'Project overview', slug: 'overview' },
        { label: 'User guides', items: [
          { label: 'Watching in a room', slug: 'guides/rooms' },
          { label: 'Browser extension', slug: 'guides/extension' },
        ] },
        { label: 'Self-hosting', items: [
          { label: 'Deployment guide', slug: 'hosting/overview' },
          { label: 'Production operations', slug: 'hosting/production' },
        ] },
        { label: 'Project reference', items: [
          { label: 'Technical specification', slug: 'reference/specification' },
          { label: 'Contributing', slug: 'contributing' },
          { label: 'Changelog', slug: 'changelog' },
          { label: 'Maintaining this site', slug: 'maintaining-docs' },
        ] },
        { label: 'Extension publication', items: [
          { label: 'Chrome Web Store', slug: 'publishing/chrome-web-store' },
          { label: 'Privacy policy', slug: 'privacy' },
        ] },
      ],
    }),
  ],
});
