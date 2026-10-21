import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = path.resolve(root, '..');
const contentRoot = path.join(root, 'src/content/docs');
const repository = 'https://github.com/rennerdo30/watch-together';
const base = '/watch-together';

// These are generated build inputs, ignored by Git. Edit the source document.
const pages = new Map([
  ['README.md', 'overview'],
  ['PRIVACY.md', 'privacy'],
  ['DEPLOYMENT.md', 'hosting/overview'],
  ['deploy/README.md', 'hosting/production'],
  ['SPECIFICATION.md', 'reference/specification'],
  ['CONTRIBUTING.md', 'contributing'],
  ['CHANGELOG.md', 'changelog'],
  ['docs/chrome-web-store.md', 'publishing/chrome-web-store'],
]);

function rewriteLink(href, source) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return href;
  if (href.startsWith('../../releases/')) return `${repository}/${href.slice(6)}`;
  const [withoutFragment, fragment] = href.split('#', 2);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), withoutFragment));
  const route = pages.get(resolved);
  if (route) return `${base}/${route}/${fragment ? `#${fragment}` : ''}`;
  return `${repository}/blob/main/${resolved}${fragment ? `#${fragment}` : ''}`;
}

for (const [source, route] of pages) {
  const original = await readFile(path.join(repositoryRoot, source), 'utf8');
  const heading = original.match(/^# (.+)\r?\n/);
  if (!heading) throw new Error(`Missing document title: ${source}`);
  const body = original.slice(heading[0].length)
    .replace(/\]\(([^\s)]+)\)/g, (_, href) => `](${rewriteLink(href, source)})`);
  const target = path.join(contentRoot, `${route}.md`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\ntitle: ${JSON.stringify(heading[1])}\n---\n${body}`);
}
console.log(`Prepared ${pages.size} documentation pages from their canonical sources.`);
