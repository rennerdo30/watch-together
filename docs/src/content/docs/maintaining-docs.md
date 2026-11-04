---
title: Maintaining this documentation
description: Build and publish the standard Astro Starlight documentation site.
---

The site has two parts. The homepage (`docs/src/pages/index.astro`) is
hand-written markup with its own stylesheet, script and fonts in
`docs/public/site/`: no framework code and nothing from another origin, which
its Content-Security-Policy enforces. Everything else is Astro Starlight with
the Galaxy theme, in the app's teal; the documentation start page is
`docs/src/content/docs/docs.md`.

## Homepage

- The room demo in the hero (`public/site/site.js`) applies the room page's
  real drift rules on every heartbeat. If the thresholds in
  `frontend/app/room/[id]/page.tsx` change, change them in the demo and in the
  "One clock for the room" section too.
- The screenshots in `docs/public/shots/` are captured from the running app,
  which the README also uses:

  ```sh
  cd frontend
  npx playwright test -c store-images/playwright.config.ts site.spec.ts
  ```

- Inter Tight and JetBrains Mono are self-hosted under the SIL Open Font
  License (`public/site/fonts/OFL.txt`).

## Local development

From the repository root:

```sh
cd docs
npm ci
npm run dev
```

Astro prints the local development address. The site is served under the
`/watch-together/` base path so previews exercise the GitHub Pages paths.

## Source documents

The build imports the existing README, deployment documentation, technical
specification, contributing guide, changelog, Chrome Web Store guide and
`PRIVACY.md`. Edit those canonical files rather than the generated Markdown in
`docs/src/content/docs/`. The sync script runs before development and builds.

User guides live directly in `docs/src/content/docs/guides/`. Update the sidebar
in `docs/astro.config.mjs` when adding a page.

## Validation and publication

```sh
npm test
```

This builds the complete site and checks the privacy-policy source, navigation,
project base path, local assets, the README's images, and that the homepage
loads nothing from another origin. GitHub Actions runs the same checks for
documentation pull requests. A successful build on `main` deploys to GitHub
Pages using the `github-pages` environment.

The public privacy URL is:

https://rennerdo30.github.io/watch-together/privacy/

It must remain accessible without a Watch Together or Cloudflare Access login.
