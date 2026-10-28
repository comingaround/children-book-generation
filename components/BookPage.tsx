'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

import { cx, swapName } from '@/lib/client';
import { fileUrl, type Book, type Page, type TextLine } from '@/lib/types';

import styles from './BookPage.module.css';

const family = (book: Book, f: { family: string }) => `"bb-${book.id}-${f.family}"`;

/** The PDF's own fonts, so rebuilt pages keep the book's lettering. */
export function BookFonts({ book }: { book: Book }) {
  const css = book.fonts
    .map(
      (f) =>
        `@font-face{font-family:${family(book, f)};src:url(${fileUrl(`books/${book.id}/${f.file}`)});font-weight:${f.weight};font-style:${f.italic ? 'italic' : 'normal'};font-display:block}`
    )
    .join('\n');
  return <style>{css}</style>;
}

/** Every embedded subset of the same PDF font, then a lookalike for letters a subset lacks. */
function lineFont(book: Book, line: TextLine): CSSProperties {
  const font = book.fonts.find((f) => f.family === line.font);
  if (!font) return { fontFamily: 'Arial, sans-serif' };
  const subsets = book.fonts.filter((f) => f.pdfName === font.pdfName).map((f) => family(book, f));
  return { fontFamily: [...subsets, font.fallback].join(', '), fontWeight: font.weight, fontStyle: font.italic ? 'italic' : 'normal' };
}

function lineStyle(book: Book, line: TextLine): CSSProperties {
  // Line box = the PDF's bbox: height in % of page height, font size in % of page width.
  const lineHeight = (line.h * book.pageHeight) / (line.size * book.pageWidth);
  const base: CSSProperties = { top: `${line.y}%`, fontSize: `calc(${line.size}cqw * var(--fit, 1))`, lineHeight, color: line.color, ...lineFont(book, line) };
  if (line.align === 'center') return { ...base, left: `${line.x + line.w / 2}%`, transform: 'translateX(-50%)' };
  if (line.align === 'right') return { ...base, right: `${100 - line.x - line.w}%` };
  return { ...base, left: `${line.x}%` };
}

interface Props {
  book: Book;
  page: Page;
  /** Art to show instead of the imported illustration (a generated attempt). */
  art?: string | null;
  /** Name swaps for the page text: [name in the book, person's name]. */
  names?: [string, string][];
  /** This run's text for the page, one string per line (names and he/she); wins over `names`. */
  texts?: string[];
  showText?: boolean;
  /** Rendered over the illustration only, in its own coordinates (the box editor). */
  overlay?: ReactNode;
  className?: string;
}

/** A page rebuilt like the PDF: the illustration where it sat, the text lines on top. */
export function BookPage({ book, page, art, names = [], texts, showText = true, overlay, className }: Props) {
  const [x0, y0, x1, y1] = page.imageRect;
  const root = useRef<HTMLDivElement>(null);

  // Browsers reject some fonts embedded in PDFs, and a lookalike runs wider or narrower.
  // Once fonts load, scale each line so the ORIGINAL text is exactly as wide as in the PDF;
  // the swapped name then sits in correctly sized type.
  useEffect(() => {
    let cancelled = false;
    const ctx = document.createElement('canvas').getContext('2d');
    void document.fonts.ready.then(() => {
      const el = root.current;
      if (cancelled || !el || !ctx) return;
      const pageWidth = el.clientWidth;
      el.querySelectorAll<HTMLElement>('[data-line]').forEach((span) => {
        const line = page.lines[Number(span.dataset.line)];
        const cs = getComputedStyle(span);
        const px = (line.size / 100) * pageWidth;
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${px}px ${cs.fontFamily}`;
        const measured = ctx.measureText(line.text).width;
        const target = (line.w / 100) * pageWidth;
        if (measured > 0) span.style.setProperty('--fit', String(Math.min(Math.max(target / measured, 0.6), 1.4)));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [page, showText]);

  return (
    <div ref={root} className={cx(styles.page, className)} style={{ aspectRatio: `${book.pageWidth} / ${book.pageHeight}` }}>
      <div className={styles.art} style={{ left: `${x0}%`, top: `${y0}%`, width: `${x1 - x0}%`, height: `${y1 - y0}%` }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local files, any size */}
        <img src={art ? fileUrl(art) : fileUrl(`books/${book.id}/${page.image}`)} alt="" draggable={false} />
        {overlay}
      </div>
      {showText &&
        page.lines.map((line, i) => (
          <span key={i} data-line={i} className={cx(styles.line, book.settings.textHalo && styles.halo)} style={lineStyle(book, line)}>
            {texts?.[i] ?? names.reduce((text, [from, to]) => swapName(text, from, to), line.text)}
          </span>
        ))}
    </div>
  );
}
