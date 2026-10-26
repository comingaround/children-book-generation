# Baby Book Preview

A local CMS that puts real people into an existing picture book: a child as the main character, and parents or friends as the other characters if you like. You import a book PDF, prepare its cast (who each character is, their clothing, their pose on every page), then choose who plays whom. Gemini draws each person once in the book's style, you approve the drawings, and every page is redrawn with their faces, hair and skin. Clothing, poses and everything else stay as they were.

```bash
npm install
npm run import:samples   # imports the PDFs in baby-books-to-gen/
npm run dev              # http://localhost:3130
```

Needs Node 20+, Python 3 with PyMuPDF (`pip install pymupdf`) for the PDF import, and a Gemini credential in `.env.local` (see `.env.example`). Locally that's `gcloud auth application-default login` with Vertex AI.

## How a book is made

1. **Import.** `scripts/import_pdf.py` takes each page's largest embedded image as its illustration, and its text lines with position, font, size and colour. It also extracts the PDF's embedded fonts. Covers, promo pages and back covers are detected and marked; the text is never part of the art, so no AI ever redraws lettering on story pages.
2. **Prepare** (book editor). Two tabs. **Characters**: the book's cast (name in the text, gender, how to recognise them, usual clothing) and, per page, which of them are on it, a box around each, their pose and direction, and an optional clothing override. **Scene & style**: page type, the scene, and the art style that goes with every drawing. **Prepare all pages with AI** finds the cast and fills every page with the cheap text model (Gemini Flash, which also finds the boxes) without overwriting edits; you correct what's wrong.
3. **Drawings** (run, step 1). On the main page you pick a book, then who plays each character from your people list. Nano Banana Pro draws each person from their photo in the book's style, in their character's outfit. The run stops until you approve the drawings; approved drawings are saved and reused for that book and character next time.
4. **Pages** (run, step 2). Each assigned character on a page is replaced in turn. Only the face, hair, skin tone and glasses change; clothing, pose and direction stay as in the book.
   - The model gets the head of the approved drawing (so it has no outfit to copy), the photo, and the book's art style with its face conventions (simple eyes, nose and mouth), so people don't come out more realistic than the book.
   - With a box, it gets a **close-up** around the main character instead of the whole page, enlarged, so even a small figure is big in its view. The result is pasted back with a soft edge, and with **Keep everything outside the box** only the box area changes, so the rest stays pixel-identical.
   - Inputs are padded to the nearest aspect ratio the model supports and cropped back, so nothing is stretched.
   - An **automatic check** (Gemini Flash) compares each character with the original: pose and direction, clothing, art style, likeness to the person, everything else unchanged. If something is off, the page is redrawn once with the check's description of the problem as the correction.
   - Regenerate takes an optional one-line correction ("back to the viewer, like the original"), for everyone on the page or one character. Every version is kept.
   - Two pages run at a time, with retries when Google is busy.
5. **View.** The page is rebuilt in the browser: the new illustration, with the original text lines on top in the book's own fonts and each character's name swapped for their person's. Before/after slider per page, a version history per page, and a book view.

## Structure

```
app/
  page.tsx                 library + child panel + recent runs
  books/[id]/page.tsx      book editor
  runs/[id]/page.tsx       a run: character check, pages, book view
  api/                     books (import, save, draft), children, runs, files
components/                one folder per screen; ui.module.css holds the shared controls,
                           app/globals.css the design tokens (matte pastels, flat, flexbox only)
lib/
  ai/gemini.ts             Gemini client (API key or Vertex + local gcloud login), retries
  ai/prompts.ts            character, page and "Draft with AI" prompts
  runner.ts                the run state machine: character → approval → pages
  images.ts                sharp: model inputs, aspect padding, box blend
  store.ts                 JSON files under data/
  types.ts                 the data shapes, shared with the browser
  migrate.ts               reads files from the single-hero version into the current shapes
scripts/import_pdf.py      PDF → data/books/<id>/
data/                      books/, children/ (people), runs/ (gitignored)
```

`data/` holds everything: imported books, child photos and generated images. It's plain files, so a book or run can be inspected or deleted by hand.

## Not built yet

- Changing he/she in the text when a person's gender differs from their character's (the setting is collected; the swap is a text pass on the imported lines).
- PDF export of a finished book.
- Logins, hosting, a storefront.
