"""Third-party terms that must stay declared.

The repository is MIT, but it bundles and publishes things that are not:
non-commercial model weights, GPL plugins in the published backend image, and
SponsorBlock data under CC BY-NC-SA 4.0, whose licence requires attribution
where the feature is offered. These checks keep each notice in place.
"""

import pathlib
import re

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
NOTICES = REPO_ROOT / "THIRD_PARTY_NOTICES.md"
SPONSORBLOCK_SITE = "https://sponsor.ajay.app/"
SPONSORBLOCK_LICENSE = "https://creativecommons.org/licenses/by-nc-sa/4.0/"


def _read(relative: str) -> str:
    return (REPO_ROOT / relative).read_text(encoding="utf-8")


def test_notices_cover_what_is_not_mit():
    text = NOTICES.read_text(encoding="utf-8")
    for required in (
        "WEIGHTS_LICENSE.md", "Non-commercial", "bgutil-ytdlp-pot-provider", "GPL-3.0",
        "FFmpeg", "CC BY-NC-SA 4.0", SPONSORBLOCK_SITE, "OFL", "not affiliated",
    ):
        assert required in text, required


def test_bundled_assets_ship_their_licence_texts():
    # frontend/public/{framegen,upscaling}/ are generated, not committed: the
    # build script must copy each licence next to the asset it covers.
    build = _read("frontend/scripts/build-upscaling.mjs")
    for copied in (
        "'LICENSE-WebSR.txt'", "'THIRD_PARTY_NOTICES.txt'", "'LICENSE.txt'", "'WEIGHTS_LICENSE.md'",
    ):
        assert copied in build, copied
    for source in ("frontend/lib/upscaling/THIRD_PARTY_NOTICES.txt", "frontend/lib/framegen/WEIGHTS_LICENSE.md"):
        assert (REPO_ROOT / source).is_file(), source
    assert "Non-commercial" in _read("frontend/lib/framegen/WEIGHTS_LICENSE.md")
    assert (REPO_ROOT / "docs/public/site/fonts/OFL.txt").is_file()


def test_every_bundled_backend_plugin_is_declared():
    # A plugin added to the image without a notice is distributed undeclared.
    dockerfile = _read("backend/Dockerfile")
    requirements = _read("backend/requirements.txt")
    notices = NOTICES.read_text(encoding="utf-8")
    plugins = set(re.findall(r"\b(yt-dlp-[a-z-]+|bgutil-[a-z-]+)", dockerfile + requirements))
    assert plugins, "expected the PO-token plugins in the backend image"
    for plugin in plugins:
        assert plugin in notices, plugin


def test_sponsorblock_is_credited_where_it_is_switched_on():
    constants = _read("frontend/lib/sponsorblock.ts")
    assert f"SPONSORBLOCK_SITE = '{SPONSORBLOCK_SITE}'" in constants
    assert f"SPONSORBLOCK_LICENSE = '{SPONSORBLOCK_LICENSE}'" in constants
    dialog = _read("frontend/components/room-settings-dialog.tsx")
    assert "href={SPONSORBLOCK_SITE}" in dialog and "href={SPONSORBLOCK_LICENSE}" in dialog
    for page in ("README.md", "docs/src/pages/index.astro"):
        assert SPONSORBLOCK_SITE in _read(page), page


def test_readme_and_website_point_to_the_notices_and_disclaim_affiliation():
    readme = _read("README.md")
    assert "](THIRD_PARTY_NOTICES.md)" in readme
    assert "not affiliated" in readme
    homepage = _read("docs/src/pages/index.astro")
    assert "THIRD_PARTY_NOTICES.md" in homepage and "not affiliated" in homepage
    assert "not affiliated" in _read("store/chrome-web-store/listing.md")
