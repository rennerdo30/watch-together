"""
Packaging the browser extension for download.

A member without the extension is offered one straight from the instance
they are using, built from the same `extension/` folder the repository
ships: the Chrome build carries the Manifest V3 file, the Firefox build the
V2 one renamed to `manifest.json`. The same code produces the nightly
release archive in CI, so the download and the release cannot drift.

This module is deliberately standard-library only and importable without
the rest of the backend: the CI workflow runs it as a script from the
repository root.
"""
import argparse
import hashlib
import io
import json
import os
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

MANIFEST_NAME = "manifest.json"
BACKGROUND_SCRIPT = "background.js"
PAGE_DIRECTORIES = ("popup", "options")
PAGE_SUFFIXES = {".html", ".css", ".js"}
ICON_DIRECTORY = "icons"
ICON_SUFFIXES = {".png", ".svg"}
CHECKSUM_SUFFIX = ".sha256"
ZIP_COMPRESSION_LEVEL = 9


@dataclass(frozen=True)
class BrowserBuild:
    key: str
    label: str
    manifest_source: str
    filename: str
    manifest_version: int


BUILDS: Dict[str, BrowserBuild] = {
    "chrome": BrowserBuild("chrome", "Chrome / Edge", "manifest.json", "watch-together-chrome.zip", 3),
    "firefox": BrowserBuild("firefox", "Firefox", "manifest.v2.json", "watch-together-firefox.zip", 2),
}


class ExtensionSourceMissing(FileNotFoundError):
    """The extension folder is not where the deployment says it is."""


def package_files(source_dir: Path, build: BrowserBuild) -> List[Tuple[Path, str]]:
    """(file on disk, name inside the archive) for everything the build ships."""
    manifest = source_dir / build.manifest_source
    if not manifest.is_file():
        raise ExtensionSourceMissing(f"{manifest} does not exist")
    files: List[Tuple[Path, str]] = [(manifest, MANIFEST_NAME)]

    background = source_dir / BACKGROUND_SCRIPT
    if not background.is_file():
        raise ExtensionSourceMissing(f"{background} does not exist")
    files.append((background, BACKGROUND_SCRIPT))

    for directory in PAGE_DIRECTORIES:
        for path in sorted((source_dir / directory).glob("*")):
            if path.is_file() and path.suffix in PAGE_SUFFIXES:
                files.append((path, path.relative_to(source_dir).as_posix()))
    for path in sorted((source_dir / ICON_DIRECTORY).glob("*")):
        if path.is_file() and path.suffix in ICON_SUFFIXES:
            files.append((path, path.relative_to(source_dir).as_posix()))
    return files


def source_fingerprint(source_dir: Path, build: BrowserBuild) -> Tuple[Tuple[str, int, int], ...]:
    """Changes whenever any packaged file changes; keys a cached archive."""
    fingerprint = []
    for path, name in package_files(source_dir, build):
        stat = path.stat()
        fingerprint.append((name, stat.st_mtime_ns, stat.st_size))
    return tuple(fingerprint)


def build_archive(source_dir: Path, build: BrowserBuild) -> bytes:
    """The ZIP a browser loads unpacked (Chrome) or as a temporary add-on (Firefox)."""
    files = package_files(source_dir, build)
    manifest = json.loads(files[0][0].read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != build.manifest_version:
        raise ValueError(
            f"{build.manifest_source} declares manifest_version {manifest.get('manifest_version')}, "
            f"the {build.label} build needs {build.manifest_version}"
        )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=ZIP_COMPRESSION_LEVEL) as archive:
        for path, name in files:
            archive.write(path, name)
    return buffer.getvalue()


def extension_version(source_dir: Path, build: BrowserBuild) -> str:
    manifest = json.loads((source_dir / build.manifest_source).read_text(encoding="utf-8"))
    return str(manifest.get("version", ""))


def checksum_line(archive: bytes, filename: str) -> str:
    return f"{hashlib.sha256(archive).hexdigest()}  {filename}\n"


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Package the Watch Together browser extension.")
    parser.add_argument("--source", required=True, help="the extension/ folder")
    parser.add_argument("--browser", required=True, choices=sorted(BUILDS))
    parser.add_argument("--output", required=True, help="path of the ZIP to write")
    parser.add_argument("--checksum", action="store_true", help="also write <output>.sha256")
    args = parser.parse_args(list(argv) if argv is not None else None)

    build = BUILDS[args.browser]
    source = Path(args.source)
    archive = build_archive(source, build)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(archive)
    if args.checksum:
        output.with_name(output.name + CHECKSUM_SUFFIX).write_text(checksum_line(archive, output.name))
    print(f"Wrote {output} ({len(archive)} bytes, {build.label} extension "
          f"{extension_version(source, build)}, {len(package_files(source, build))} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
