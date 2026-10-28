"""Export a finished run as a PDF, built from the book's original PDF.

Reads a JSON spec on stdin:

    {
      "source": ".../data/books/<id>/source.pdf",
      "out": ".../data/runs/<run>/book.pdf",
      "keep": [1, 3, 4, ...],               # PDF page numbers, in order (skipped pages left out)
      "art": {"3": ".../page-3.png", ...},  # new illustration per page
      "lines": {"3": [{"text": "...", "newText": "...", "align": "left"}]},
      "bleed": 8.5                          # points of bleed per side, 0 for none
    }

Each page's illustration (its largest image, as in import_pdf.py) is replaced with the new one,
so the text, fonts and layout of the original stay as they are. Only the lines whose text
changed (names, he/she) are rewritten: removed and set again in the same font, size and colour,
shrunk if the new text is wider than the old line.

With bleed, each page is placed on a larger sheet (trim box = the original page) and a thin
strip along each edge is stretched outwards over the bleed, so the page runs on past the cut.

    python -I scripts/export_pdf.py < spec.json
"""

import json
import sys

import pymupdf

# Line boxes overlap a little; removing only the middle of a line keeps its neighbours intact.
REDACT_INSET = 0.2


def largest_image(page):
    best = None
    for info in page.get_images(full=True):
        for rect in page.get_image_rects(info[0]):
            area = rect.width * rect.height
            if not best or area > best[0]:
                best = (area, info[0], rect)
    return best


def replace_art(page, png: str) -> None:
    best = largest_image(page)
    if best:
        page.replace_image(best[1], filename=png)
    else:
        # A flattened page (no images): the whole page was the art, text included.
        page.insert_image(page.rect, filename=png, overlay=True)


# Fallbacks for letters the book's (subset) font doesn't have, by the font's style, like the
# browser fallbacks import_pdf.py writes. The first file that exists wins; else a built-in font.
FALLBACKS = {
    "comic": ["C:/Windows/Fonts/comic.ttf", "/usr/share/fonts/truetype/comic-neue/ComicNeue-Regular.ttf"],
    "serif": ["C:/Windows/Fonts/georgia.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"],
    # Noto Sans, Open Sans and kin: open, rounded shapes that Arial doesn't match.
    "humanist": ["C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
    "sans": ["C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
}
BOLD = {"comic.ttf": "comicbd.ttf", "georgia.ttf": "georgiab.ttf", "arial.ttf": "arialbd.ttf", "segoeui.ttf": "segoeuib.ttf", "NotoSans-Regular.ttf": "NotoSans-Bold.ttf"}
HUMANIST = ("noto", "opensans", "open sans", "droid", "segoe")


def fallback_font(span_font: str, bold: bool):
    """A full Unicode TTF in the font's style, as (fontname, Font, buffer)."""
    name = span_font.lower()
    if "comic" in name:
        style = "comic"
    elif any(k in name for k in ("times", "garamond", "georgia", "serif", "book", "century")):
        style = "serif"
    else:
        style = "humanist" if any(k in name for k in HUMANIST) else "sans"
    for path in FALLBACKS[style]:
        if bold and path.rsplit("/", 1)[-1] in BOLD:
            path = path.rsplit("/", 1)[0] + "/" + BOLD[path.rsplit("/", 1)[-1]]
        try:
            buffer = open(path, "rb").read()
        except OSError:
            continue
        return f"FB{style}{int(bold)}", pymupdf.Font(fontbuffer=buffer), buffer
    return ("tiro" if style == "serif" else "helv"), pymupdf.Font("tiro" if style == "serif" else "helv"), None


def embedded_font(doc, page, span_font: str):
    """The span's own font from the PDF, as (fontname, Font, buffer), or None."""
    for xref, _ext, _type, basefont, *_ in page.get_fonts():
        name = basefont.split("+", 1)[-1]
        if name.startswith(span_font) or span_font.startswith(name):
            _, _, _, buffer = doc.extract_font(xref)
            return (f"F{xref}", pymupdf.Font(fontbuffer=buffer), buffer) if buffer else None
    return None


def runs_of(text: str, primary, fallback) -> list:
    """Splits text into runs: the book's font wherever it has the glyph, the fallback elsewhere."""
    out = []
    for ch in text:
        use = primary if primary and primary[1].has_glyph(ord(ch)) else fallback
        if out and out[-1][0] is use:
            out[-1][1] += ch
        else:
            out.append([use, ch])
    return out


def rewrite_lines(doc, page, changes: list) -> None:
    targets = []
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 0:
            continue
        for line in block["lines"]:
            text = "".join(s["text"] for s in line["spans"]).strip()
            spans = [s for s in line["spans"] if s["text"].strip()]
            change = next((c for c in changes if c["text"] == text), None)
            if change and spans:
                targets.append((line, spans[0], change))
    if not targets:
        return

    for line, _, _ in targets:
        r = pymupdf.Rect(line["bbox"])
        inset = r.height * REDACT_INSET
        page.add_redact_annot(pymupdf.Rect(r.x0, r.y0 + inset, r.x1, r.y1 - inset))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)

    inserted = set()
    for line, span, change in targets:
        x0, _, x1, _ = line["bbox"]
        new = change["newText"]
        primary = embedded_font(doc, page, span["font"])
        fallback = fallback_font(span["font"], bool(span["flags"] & 16))
        runs = runs_of(new, primary, fallback)
        for (fontname, _font, buffer), _ in runs:
            if buffer and fontname not in inserted:
                page.insert_font(fontname=fontname, fontbuffer=buffer)
                inserted.add(fontname)

        size = span["size"]
        width = sum(font.text_length(part, fontsize=size) for (_, font, _), part in runs)
        if width > x1 - x0 and len(new) > len(change["text"]):
            size *= (x1 - x0) / width
            width = x1 - x0
        x = {"center": (x0 + x1 - width) / 2, "right": x1 - width}.get(change.get("align"), x0)
        c = span["color"]
        color = [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]
        for (fontname, font, _), part in runs:
            page.insert_text((x, span["origin"][1]), part, fontname=fontname, fontsize=size, color=color)
            x += font.text_length(part, fontsize=size)


# The bleed, and the page's outer EDGE points (inside any printer's safe margin, so nothing is
# lost), are filled from a strip just inside that: hairlines some books have at the edge go away.
EDGE = 3
STRIP = 1


def with_bleed(doc, bleed: float):
    """A new document: each page centred on a sheet `bleed` larger per side, its edges extended."""
    out = pymupdf.open()
    for page in doc:
        w, h = page.rect.width, page.rect.height
        sheet = out.new_page(width=w + 2 * bleed, height=h + 2 * bleed)
        W, H = sheet.rect.width, sheet.rect.height
        trim = pymupdf.Rect(bleed, bleed, bleed + w, bleed + h)
        sheet.show_pdf_page(trim, doc, page.number)
        e, a, b = bleed + EDGE, EDGE, EDGE + STRIP
        # (target on the sheet, source strip on the page): four sides, then four corners on top.
        bands = [
            ((0, e, e, H - e), (a, a, b, h - a)),
            ((W - e, e, W, H - e), (w - b, a, w - a, h - a)),
            ((e, 0, W - e, e), (a, a, w - a, b)),
            ((e, H - e, W - e, H), (a, h - b, w - a, h - a)),
            ((0, 0, e, e), (a, a, b, b)),
            ((W - e, 0, W, e), (w - b, a, w - a, b)),
            ((0, H - e, e, H), (a, h - b, b, h - a)),
            ((W - e, H - e, W, H), (w - b, h - b, w - a, h - a)),
        ]
        for target, clip in bands:
            sheet.show_pdf_page(pymupdf.Rect(target), doc, page.number, clip=pymupdf.Rect(clip), keep_proportion=False)
        sheet.set_bleedbox(sheet.rect)
        sheet.set_trimbox(trim)
    return out


def main() -> None:
    # Bytes, not text: on Windows stdin would be decoded as cp1252 and curly quotes would not match.
    spec = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    doc = pymupdf.open(spec["source"])
    for number in spec["keep"]:
        page = doc[number - 1]
        png = spec["art"].get(str(number))
        if png:
            replace_art(page, png)
        changes = spec["lines"].get(str(number))
        if changes:
            rewrite_lines(doc, page, changes)
    doc.select([n - 1 for n in spec["keep"]])
    if spec.get("bleed"):
        doc = with_bleed(doc, spec["bleed"])
    doc.save(spec["out"], garbage=3, deflate=True)
    print(spec["out"])


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 - the route shows this line to the owner
        print(f"EXPORT_ERROR: {err}", file=sys.stderr)
        raise
