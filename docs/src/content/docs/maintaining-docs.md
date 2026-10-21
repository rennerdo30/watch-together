---
title: Maintaining this documentation
description: Build and publish the standard Astro Starlight documentation site.
---

This site uses the project's standard
[docs-template](https://github.com/rennerdo30/docs-template) structure: Astro
Starlight, the Galaxy theme and the shared orange accents.

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
project base path and local assets. GitHub Actions runs the same checks for
documentation pull requests. A successful build on `main` deploys to GitHub
Pages using the `github-pages` environment.

The public privacy URL is:

https://rennerdo30.github.io/watch-together/privacy/

It must remain accessible without a Watch Together or Cloudflare Access login.
