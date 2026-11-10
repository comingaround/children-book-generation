import 'server-only';

import { HttpError } from './http-error';
import { readDataFile, requireBook } from './store';
import type { Book } from './types';
import { fileOf } from './upload';

/** A book for one AI call, and how to read its page art (an image path from book.json). */
export interface BookInput {
  book: Book;
  read: (image: string) => Promise<Buffer>;
}

/** The form field a browser book's page art comes in. */
export const artField = (image: string) => `book:${image}`;

/**
 * The book an AI call is about. A published book is named by `bookId` and read from data/books/.
 * A book kept in the visitor's browser comes whole as `book`, with the art the call needs as
 * `book:<image>` files (lib/local/books.ts sends them); nothing of it is saved here.
 */
export async function bookFrom(spec: { bookId?: string; book?: Book }, form?: FormData): Promise<BookInput> {
  if (spec.book) {
    const book = spec.book;
    if (typeof book.id !== 'string' || !Array.isArray(book.pages) || !Array.isArray(book.characters) || !book.settings) throw new HttpError(400, 'That book could not be read');
    return {
      book,
      read: (image) => {
        if (!form) throw new HttpError(400, 'The book’s pages are missing');
        return fileOf(form, artField(image), 'A page of the book');
      },
    };
  }
  if (!spec.bookId) throw new HttpError(400, 'Which book?');
  const book = await requireBook(spec.bookId);
  return { book, read: (image) => readDataFile(`books/${book.id}/${image}`) };
}
