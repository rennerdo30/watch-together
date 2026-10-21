"""Checks against the actual Pages artifact produced by the standard template."""

from html.parser import HTMLParser
from pathlib import Path
import unittest
from urllib.parse import unquote, urlsplit

DOCS = Path(__file__).resolve().parents[1]
ROOT = DOCS.parent
SITE = DOCS / "dist"


class Page(HTMLParser):
    def __init__(self, html: str) -> None:
        super().__init__()
        self.links: list[str] = []
        self.text: list[str] = []
        self.feed(html)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for key, value in attrs:
            if value and key in {"href", "src"}:
                self.links.append(value)

    def handle_data(self, data: str) -> None:
        self.text.append(data)


class DocumentationSite(unittest.TestCase):
    def test_home_links_directly_to_public_policy(self) -> None:
        page = Page((SITE / "index.html").read_text())
        self.assertIn("/watch-together/privacy/", page.links)
        self.assertIn("support@renner.dev", "".join(page.text))

    def test_policy_is_imported_from_its_canonical_source(self) -> None:
        original = (ROOT / "PRIVACY.md").read_text().split("\n", 1)[1].lstrip()
        generated = (DOCS / "src/content/docs/privacy.md").read_text().split("---", 2)[2].lstrip()
        self.assertEqual(original, generated)
        self.assertIn("docs/src/content/docs/privacy.md", (ROOT / ".gitignore").read_text())
        page = Page((SITE / "privacy/index.html").read_text())
        text = " ".join(" ".join(page.text).split())
        for phrase in ["authentication cookies", "other members", "30 minutes", "Limited Use", "support@renner.dev"]:
            self.assertIn(phrase, text)

    def test_internal_links_and_assets_resolve_under_the_project_path(self) -> None:
        for path in SITE.rglob("*.html"):
            for link in Page(path.read_text()).links:
                parts = urlsplit(link)
                if parts.scheme or parts.netloc or not parts.path:
                    continue
                relative = unquote(parts.path)
                if relative.startswith("/"):
                    self.assertTrue(relative == "/watch-together" or relative.startswith("/watch-together/"), link)
                    target = SITE / relative.removeprefix("/watch-together").lstrip("/")
                else:
                    target = path.parent / relative
                if target.is_dir():
                    target /= "index.html"
                self.assertTrue(target.is_file(), f"{path.relative_to(SITE)} links missing {link}")

    def test_search_is_built_and_build_sources_are_not_published(self) -> None:
        self.assertTrue((SITE / "pagefind/pagefind.js").is_file())
        for name in ["scripts/sync-content.mjs", "package.json", "tests/test_site.py"]:
            self.assertFalse((SITE / name).exists())


if __name__ == "__main__":
    unittest.main()
