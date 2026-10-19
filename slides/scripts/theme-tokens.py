"""One-off: move the editor chrome's hard-coded colours to CSS variables (--pp-*), so the app can be
themed light/dark and by a hosting page. Slide content (element renderers, thumbnails' slide
surface, the slideshow) keeps its colours: those are the user's slides, not chrome."""
import re
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
SKIP = ("views/components/element/", "views/components/ThumbnailSlide/", "views/Screen/", "assets/styles/theme.css", "assets/styles/prosemirror.scss")

def alpha(match):
    a = float(match.group(1))
    return f"color-mix(in srgb, var(--pp-accent) {round(a * 100)}%, transparent)"

BG = {"#fff": "surface", "#ffffff": "surface", "#f9f9f9": "surface-2", "#fafafa": "surface-2", "#f5f5f5": "surface-2", "#f7f7f7": "surface-2",
      "#f1f1f1": "surface-3", "#f0f0f0": "surface-3", "#eee": "surface-3", "#eeeeee": "surface-3", "#e5e5e5": "surface-4", "#e1e1e1": "surface-4",
      "#ddd": "surface-4", "#dcdcdc": "surface-4", "#d9d9d9": "surface-4"}
FG = {"#333": "text", "#262626": "text", "#1d1d1d": "text", "#3a3a3a": "text", "#41464b": "text", "#000": "text",
      "#555": "text-2", "#666": "text-2", "#888": "text-3", "#999": "text-3", "#aaa": "text-3",
      "#b7b7b7": "text-4", "#bfbfbf": "text-4", "#ccc": "text-4"}
BORDER = {"#d9d9d9": "border", "#ccc": "border", "#e5e5e5": "border", "#e1e1e1": "border", "#dcdcdc": "border", "#ddd": "border",
          "#eee": "border", "#f0f0f0": "border", "#f1f1f1": "border", "#e5e7eb": "border",
          "#b7b7b7": "border-strong", "#bfbfbf": "border-strong", "#aaa": "border-strong", "#999": "border-strong"}

DECL = re.compile(r"(?P<prop>(?:background(?:-color)?|color|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?))\s*:\s*(?P<value>[^;{}\n]+)")
HEX = re.compile(r"#[0-9a-fA-F]{3,6}\b")

def map_decl(match):
    prop, value = match.group("prop"), match.group("value")
    table = BG if prop.startswith("background") else FG if prop == "color" else BORDER
    def swap(hexmatch):
        name = table.get(hexmatch.group(0).lower())
        return f"var(--pp-{name})" if name else hexmatch.group(0)
    return f"{prop}: {HEX.sub(swap, value)}"

def theme(css):
    css = re.sub(r"lighten\(\$themeColor, 8%\)", "var(--pp-accent-hover)", css)
    css = re.sub(r"rgba\(\$color:\s*\$themeColor,\s*\$alpha:\s*([.\d]+)\)", alpha, css)
    css = re.sub(r"rgba\(\$themeColor,\s*([.\d]+)\)", alpha, css)
    return DECL.sub(map_decl, css)

changed = 0
for path in sorted(SRC.rglob("*")):
    rel = path.relative_to(SRC).as_posix()
    if path.suffix not in (".vue", ".scss") or rel.startswith(SKIP) or rel == "assets/styles/variable.scss":
        continue
    text = path.read_text()
    if path.suffix == ".vue":
        new = re.sub(r"(<style[^>]*>)(.*?)(</style>)", lambda m: m.group(1) + theme(m.group(2)) + m.group(3), text, flags=re.S)
    else:
        new = theme(text)
    if new != text:
        path.write_text(new)
        changed += 1
print("files changed:", changed)
