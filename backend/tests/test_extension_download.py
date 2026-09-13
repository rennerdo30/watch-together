"""
Tests for the in-app extension download.

The Settings dialog used to link to `/extension/chrome`, `/extension/firefox`
and `/extension/safari` — addresses nothing served. Members clicked
"Install" and got a 404. The backend now packages the extension from the
mounted source folder, and the same packager builds the nightly release.
"""
import io
import json
import os
import pathlib
import sys
import zipfile

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DEVELOPMENT_MODE", "true")

from core import config
from services import extension_package

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
EXTENSION = REPO_ROOT / "extension"


@pytest.fixture
def client(monkeypatch):
    import api.routes.extension as routes
    from main import app
    monkeypatch.setattr(config, "EXTENSION_SOURCE_DIR", str(EXTENSION))
    routes._package_cache.clear()
    return TestClient(app)


def read_manifest(archive: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        return json.loads(zipped.read("manifest.json"))


class TestPackager:
    def test_chrome_build_carries_the_v3_manifest(self):
        archive = extension_package.build_archive(EXTENSION, extension_package.BUILDS["chrome"])
        assert read_manifest(archive)["manifest_version"] == 3
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            names = set(zipped.namelist())
        assert "background.js" in names and "popup/popup.html" in names and "options/options.js" in names
        assert "manifest.v2.json" not in names
        assert any(name.startswith("icons/") and name.endswith(".png") for name in names)

    def test_firefox_build_renames_the_v2_manifest(self):
        archive = extension_package.build_archive(EXTENSION, extension_package.BUILDS["firefox"])
        assert read_manifest(archive)["manifest_version"] == 2
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            names = set(zipped.namelist())
        assert "manifest.v2.json" not in names
        # The V2 manifest points at the SVG icon.
        assert "icons/icon.svg" in names

    def test_every_source_file_the_extension_needs_is_packaged(self):
        """A file added to popup/ or options/ but missed by the packager breaks the build silently."""
        files = {name for _, name in extension_package.package_files(EXTENSION, extension_package.BUILDS["chrome"])}
        for directory in ("popup", "options"):
            for path in (EXTENSION / directory).iterdir():
                if path.suffix in extension_package.PAGE_SUFFIXES:
                    assert path.relative_to(EXTENSION).as_posix() in files

    def test_wrong_manifest_version_is_refused(self, tmp_path):
        (tmp_path / "manifest.json").write_text(json.dumps({"manifest_version": 2, "version": "1"}))
        (tmp_path / "background.js").write_text("")
        with pytest.raises(ValueError):
            extension_package.build_archive(tmp_path, extension_package.BUILDS["chrome"])

    def test_missing_source_is_a_distinct_error(self, tmp_path):
        with pytest.raises(extension_package.ExtensionSourceMissing):
            extension_package.build_archive(tmp_path / "nowhere", extension_package.BUILDS["chrome"])

    def test_command_line_writes_archive_and_checksum(self, tmp_path):
        output = tmp_path / "out" / "ext.zip"
        assert extension_package.main([
            "--source", str(EXTENSION), "--browser", "chrome", "--output", str(output), "--checksum",
        ]) == 0
        assert read_manifest(output.read_bytes())["manifest_version"] == 3
        checksum = (tmp_path / "out" / "ext.zip.sha256").read_text()
        assert checksum.endswith("  ext.zip\n") and len(checksum.split()[0]) == 64

    def test_is_importable_without_the_backend(self):
        """CI runs it from the repository root, where `core` does not exist."""
        source = (REPO_ROOT / "backend" / "services" / "extension_package.py").read_text(encoding="utf-8")
        for forbidden in ("from core", "import core", "from services", "import fastapi"):
            assert forbidden not in source


class TestDownloadEndpoint:
    @pytest.mark.parametrize("browser, version, filename", [
        ("chrome", 3, "watch-together-chrome.zip"),
        ("firefox", 2, "watch-together-firefox.zip"),
    ])
    def test_serves_a_zip_attachment(self, client, browser, version, filename):
        response = client.get(f"/api/extension/download/{browser}")
        assert response.status_code == 200, response.text
        assert response.headers["content-type"] == "application/zip"
        assert response.headers["content-disposition"] == f'attachment; filename="{filename}"'
        assert read_manifest(response.content)["manifest_version"] == version

    def test_unknown_browser_is_404(self, client):
        assert client.get("/api/extension/download/safari").status_code == 404

    def test_missing_source_is_503_not_500(self, client, monkeypatch):
        monkeypatch.setattr(config, "EXTENSION_SOURCE_DIR", "/nowhere/extension")
        response = client.get("/api/extension/download/chrome")
        assert response.status_code == 503
        assert "not available" in response.json()["detail"]

    def test_archive_is_rebuilt_only_when_the_source_changes(self, client, monkeypatch):
        import api.routes.extension as routes
        calls = []
        real = extension_package.build_archive

        def counting(source, build):
            calls.append(build.key)
            return real(source, build)

        monkeypatch.setattr(extension_package, "build_archive", counting)
        client.get("/api/extension/download/chrome")
        client.get("/api/extension/download/chrome")
        assert calls == ["chrome"]
        routes._package_cache.clear()
        client.get("/api/extension/download/chrome")
        assert calls == ["chrome", "chrome"]

    def test_needs_no_identity(self, client):
        """The source is public; requiring identity would only block the install."""
        assert client.get("/api/extension/download/chrome").status_code == 200
