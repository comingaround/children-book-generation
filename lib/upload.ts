import 'server-only';

import { HttpError } from './http-error';

const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** The JSON part of a multipart request from the browser (field `spec`). */
export function specOf<T>(form: FormData): T {
  try {
    return JSON.parse(String(form.get('spec') ?? '')) as T;
  } catch {
    throw new HttpError(400, 'Bad request');
  }
}

/** A file part as a Buffer; `what` names it in the error the customer sees. */
export async function fileOf(form: FormData, field: string, what: string): Promise<Buffer> {
  const file = form.get(field);
  if (!(file instanceof File) || !file.size) throw new HttpError(400, `${what} is missing`);
  if (file.size > MAX_FILE_BYTES) throw new HttpError(413, `${what} is over 15 MB`);
  return Buffer.from(await file.arrayBuffer());
}

export const jpegResponse = (jpeg: Buffer) => new Response(new Uint8Array(jpeg), { headers: { 'content-type': 'image/jpeg' } });
