import 'server-only';

/** An error that knows its HTTP status and a message that is safe to show the customer. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly userMessage: string,
    logMessage = userMessage
  ) {
    super(logMessage);
  }
}

/** Runs a route body; HttpErrors become `{ error }` JSON, anything else becomes `fallback`. */
export async function respond(
  tag: string,
  fallback: { status: number; message: string },
  handler: () => Promise<Response>
): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    console.error(`[${tag}]`, err instanceof Error ? err.message : err);
    const { status, userMessage } = err instanceof HttpError ? err : { status: fallback.status, userMessage: fallback.message };
    return Response.json({ error: userMessage }, { status });
  }
}

export const pngResponse = (png: Buffer, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', ...headers } });
