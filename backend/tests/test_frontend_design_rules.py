"""Design rules for the web app that a review keeps having to re-find.

Source assertions, because each of these was a footgun that crept back in:
text set at 9-11 px in hand-picked pixel sizes, bold weights mixed with
semibold for the same role, and classes that no longer exist (a button whose
foreground class was removed silently loses its colour).
"""

import re
from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
SOURCES = sorted(
    path
    for folder in ("app", "components")
    for path in (FRONTEND / folder).rglob("*.tsx")
)
CSS = (FRONTEND / "app" / "globals.css").read_text(encoding="utf-8")


def _offenders(pattern: str) -> list[str]:
    found = []
    for path in SOURCES:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(pattern, line):
                found.append(f"{path.relative_to(FRONTEND)}:{number}")
    return found


def test_sources_were_found():
    assert len(SOURCES) > 10


def test_no_hand_picked_pixel_text_sizes():
    # The scale is text-2xs (11 px, badges only), text-xs, text-ui, text-sm, ...
    assert _offenders(r"\btext-\[\d+(\.\d+)?px\]") == []


def test_no_bold_or_black_weights():
    # Headings are semibold; bold beside semibold reads as a mistake.
    assert _offenders(r"\bfont-(bold|extrabold|black)\b") == []


def test_accent_foreground_classes_exist():
    for name in ("on-accent", "theme-swatch", "ui-label", "ui-meta", "ui-title", "ui-heading", "ui-numeric"):
        assert re.search(rf"\.{name}\s*\{{", CSS), name
    assert _offenders(r"\b(on-accent-light|on-accent-dark|knob-on-accent)\b") == []


def test_the_accent_is_the_theme_and_teal_by_default():
    # The theme picker once wrote nothing: --accent-primary was a constant.
    assert "--accent-primary: var(--theme-accent-dark, #2fc4b2)" in CSS
    assert "--accent-primary: var(--theme-accent-light, #0f766e)" in CSS
    themes = (FRONTEND / "lib" / "themes.ts").read_text(encoding="utf-8")
    assert "export const DEFAULT_THEME = THEMES[0];" in themes
    assert re.search(r"THEMES: Theme\[\] = \[\s*\{ id: 'tide'", themes)


def test_every_custom_property_used_is_defined():
    # The redesign removed --accent-secondary while a chat button still
    # coloured itself with it, and an undefined variable fails silently.
    defined = set(re.findall(r"(--[a-z0-9-]+)\s*:", CSS))
    # Set at runtime (themes, inline styles) rather than in the stylesheet.
    runtime = {"--theme-accent-dark", "--theme-on-dark", "--theme-accent-light", "--theme-on-light",
               "--swatch-dark", "--swatch-light", "--sidebar-width"}
    used = set()
    for path in SOURCES:
        used |= set(re.findall(r"var\((--[a-z0-9-]+)", path.read_text(encoding="utf-8")))
    used = {name for name in used if not name.startswith(("--tw-", "--font-ui-"))}
    assert sorted(used - defined - runtime) == []
