import 'server-only';

import { HttpError } from './http-error';

/**
 * The public demo on Vercel (books.noslackallowed.dev): only Make a book and the customer's
 * preview. The owner's side (importing, editing, run tools) and the PDF export need the local
 * disk and Python, so they're local only. Vercel sets VERCEL=1 on its builds and functions.
 */
export const HOSTED = process.env.VERCEL === '1';

/** For owner-only routes: online they don't exist. */
export function localOnly(): void {
  if (HOSTED) throw new HttpError(404, 'Not found');
}
