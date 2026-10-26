"""Import a picture-book PDF into data/books/<id>/.

For every page it keeps the illustration without text (the largest embedded
image), the text lines with their position, font and colour, and the fonts
embedded in the PDF, so the page can be rebuilt in the browser with a new
illustration underneath and the hero's name swapped in the text.

    python -I scripts/import_pdf.py <file.pdf> [--id some-id]
    python -I scripts/import_pdf.py --samples     # every PDF in baby-books-to-gen/

Prints the new book id on the last line. Needs PyMuPDF (`pip install pymupdf`).
"""

import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
BOOKS = ROOT / "data" / "books"
SAMPLES = ROOT / "baby-books-to-gen"

THUMB_MAX = 420
# Publisher promos and ads that are not part of the story.
AD_LINE = re.compile(r"advertisement|published by|www\.|\.com\b", re.I)
SKIP_PAGE = re.compile(r"dear supporter|discover more|your story book|personalised children", re.I)
FRONT_MATTER = re.compile(r"published by", re.I)


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "book"


def title_from(name: str) -> str:
    return re.sub(r"[_\-]+", " ", name).strip().title()


def hex_color(value) -> str:
    if isinstance(value, int):
        return f"#{value:06x}"
    r, g, b = (round(c * 255) for c in value[:3])
    return f"#{r:02x}{g:02x}{b:02x}"


def pct(value: float, total: float) -> float:
    return round(value / total * 100, 3)


def save_fonts(doc, out: Path) -> list:
    """Writes every embedded TrueType/OpenType font once; returns their descriptors."""
    fonts, seen = [], {}
    for page in doc:
        for xref, ext, _type, basefont, *_ in page.get_fonts():
            if xref in seen:
                continue
            name = basefont.split("+", 1)[-1]
            seen[xref] = name
            _, real_ext, _, buffer = doc.extract_font(xref)
            if real_ext not in ("ttf", "otf") or not buffer:
                continue
            file = f"fonts/f{len(fonts) + 1}.{real_ext}"
            (out / file).write_bytes(buffer)
            fonts.append({
                "family": f"f{len(fonts) + 1}",
                "file": file,
                "pdfName": name,
                "weight": 700 if re.search(r"bold|black|heavy", name, re.I) else 400,
                "italic": bool(re.search(r"italic|oblique", name, re.I)),
                "fallback": fallback_for(name),
            })
    return fonts


def fallback_for(name: str) -> str:
    n = name.lower()
    if "comic" in n:
        return '"Comic Sans MS", "Comic Neue", cursive'
    if any(k in n for k in ("times", "garamond", "georgia", "serif", "americana", "bookman", "century")):
        return 'Georgia, "Times New Roman", serif'
    return "Arial, Helvetica, sans-serif"


def font_for(span_font: str, fonts: list):
    for f in fonts:
        if f["pdfName"].startswith(span_font) or span_font.startswith(f["pdfName"]):
            return f
    return None


def align_of(lines: list, page_w: float) -> str:
    """Left, centre or right, from how the line edges line up within one paragraph."""
    if len(lines) == 1:
        x0, _, x1, _ = lines[0]["bbox"]
        return "center" if abs((x0 + x1) / 2 - page_w / 2) < page_w * 0.03 else "left"

    def spread(values):
        return max(values) - min(values)

    lefts = [l["bbox"][0] for l in lines]
    rights = [l["bbox"][2] for l in lines]
    centres = [(l["bbox"][0] + l["bbox"][2]) / 2 for l in lines]
    best = min((spread(lefts), "left"), (spread(rights), "right"), (spread(centres), "center"))
    return best[1]


def paragraphs(lines: list) -> list:
    """Groups lines into paragraphs: same type size, stacked closely, overlapping sideways.
    PDF blocks can't be trusted for this; some books put every line in its own block."""
    groups = []
    for line in lines:
        x0, y0, x1, y1 = line["bbox"]
        last = groups[-1][-1] if groups else None
        if last:
            lx0, ly0, lx1, ly1 = last["bbox"]
            same_size = abs(last["first"]["size"] - line["first"]["size"]) < 0.6
            close = -(ly1 - ly0) * 0.5 <= y0 - ly1 < (ly1 - ly0) * 1.2  # line boxes often overlap a little
            overlap = min(x1, lx1) > max(x0, lx0)
            if same_size and close and overlap:
                groups[-1].append(line)
                continue
        groups.append([line])
    return groups


def text_lines(page, fonts: list) -> list:
    w, h = page.rect.width, page.rect.height
    kept = []
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 0:
            continue
        for line in block["lines"]:
            spans = [s for s in line["spans"] if s["text"].strip()]
            text = "".join(s["text"] for s in line["spans"]).strip()
            if not spans or not text or AD_LINE.search(text):
                continue
            kept.append({**line, "first": spans[0], "text": text})

    out = []
    for group in paragraphs(kept):
        align = align_of(group, w)
        for line in group:
            x0, y0, x1, y1 = line["bbox"]
            span = line["first"]
            font = font_for(span["font"], fonts)
            out.append({
                "text": line["text"],
                "x": pct(x0, w),
                "y": pct(y0, h),
                "w": pct(x1 - x0, w),
                "h": pct(y1 - y0, h),
                "size": pct(span["size"], w),
                "font": font["family"] if font else None,
                "color": hex_color(span["color"]),
                "align": align,
            })
    return out


def save_art(doc, page, index: int, out: Path) -> dict:
    """The page's biggest image is its illustration; the text sits on top of it in the PDF."""
    best = None
    for info in page.get_images(full=True):
        xref, smask = info[0], info[1]
        for rect in page.get_image_rects(xref):
            area = rect.width * rect.height
            if not best or area > best[0]:
                best = (area, xref, smask, rect)
    if not best:
        pix = page.get_pixmap(dpi=200)
        rect = page.rect
    else:
        _, xref, smask, rect = best
        pix = pymupdf.Pixmap(doc, xref)
        if smask:
            pix = pymupdf.Pixmap(pix, pymupdf.Pixmap(doc, smask))
        if pix.colorspace and pix.colorspace.n != 3:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        if pix.alpha:
            pix = pymupdf.Pixmap(pix, 0)

    name = f"{index:02d}"
    pix.save(out / "pages" / f"{name}.png")
    width, height = pix.width, pix.height
    while pix.width > THUMB_MAX:
        pix.shrink(1)
    pix.save(out / "thumbs" / f"{name}.jpg", jpg_quality=82)

    pw, ph = page.rect.width, page.rect.height
    return {
        "image": f"pages/{name}.png",
        "thumb": f"thumbs/{name}.jpg",
        "imageWidth": width,
        "imageHeight": height,
        # Clamp: art is often placed a hair past the trim edge.
        "imageRect": [
            max(pct(rect.x0, pw), 0), max(pct(rect.y0, ph), 0),
            min(pct(rect.x1, pw), 100), min(pct(rect.y1, ph), 100),
        ],
    }


def import_pdf(pdf: Path, book_id: str | None = None) -> str:
    book_id = book_id or slugify(pdf.stem)
    out = BOOKS / book_id
    if out.exists():
        shutil.rmtree(out)
    for sub in ("pages", "thumbs", "fonts"):
        (out / sub).mkdir(parents=True)
    shutil.copyfile(pdf, out / "source.pdf")

    doc = pymupdf.open(pdf)
    fonts = save_fonts(doc, out)
    first_texts = []
    pages = []
    for i, page in enumerate(doc, start=1):
        lines = text_lines(page, fonts)
        # Ad lines are already dropped, so a story page with an ad footer isn't skipped.
        joined = " ".join(l["text"] for l in lines)
        full_text = joined
        # A back cover repeats an earlier page's blurb.
        repeat = i == doc.page_count and any(joined[:40] and t.startswith(joined[:40]) for t in first_texts)
        first_texts.append(joined)

        if i == 1:
            kind = "cover"
        elif SKIP_PAGE.search(full_text) or repeat:
            kind = "skip"
        else:
            kind = "page"

        pages.append({
            "index": i,
            "kind": kind,
            **save_art(doc, page, i, out),
            "hasProtagonist": kind != "skip" and not FRONT_MATTER.search(page.get_text()),
            "box": None,
            "characterHint": "",
            "scenePrompt": "",
            "lines": lines,
        })

    first = doc[0].rect
    book = {
        "id": book_id,
        "title": title_from(pdf.stem),
        "source": "source.pdf",
        "importedAt": datetime.now(timezone.utc).isoformat(),
        "pageWidth": round(first.width, 2),
        "pageHeight": round(first.height, 2),
        "fonts": fonts,
        "settings": {
            "artStyle": "",
            "protagonistName": "",
            "protagonistGender": "boy",
            "protagonistDescription": "",
            "keepOutsideBox": True,
            "textHalo": False,
        },
        "pages": pages,
    }
    (out / "book.json").write_text(json.dumps(book, indent=2, ensure_ascii=False), encoding="utf-8")
    return book_id


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", nargs="?")
    parser.add_argument("--id")
    parser.add_argument("--samples", action="store_true")
    args = parser.parse_args()

    if args.samples:
        for pdf in sorted(SAMPLES.glob("*.pdf")):
            print(import_pdf(pdf))
        return
    if not args.pdf:
        parser.error("give a PDF path or --samples")
    print(import_pdf(Path(args.pdf), args.id))


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # surfaced to the API route as the error message
        print(f"IMPORT_ERROR: {err}", file=sys.stderr)
        sys.exit(1)
