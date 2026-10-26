/** Browser helpers. */

/** fetch + JSON; a non-2xx answer throws with the server's `{ error }` message. */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json', ...rest.headers } } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

export const money = (usd: number) => `$${usd.toFixed(2)}`;

export const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

export function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Matches any of `names` as whole words, ignoring case. Used to swap names and to mark them. */
export const nameRegex = (names: string[]) =>
  new RegExp(`\\b(?:${names.map((n) => n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');

/** Swaps a character's name for a person's in page text, keeping ALL-CAPS where the book used it. */
export function swapName(text: string, from: string, to: string): string {
  if (!from.trim() || !to.trim()) return text;
  return text.replace(nameRegex([from]), (match) => (match === match.toUpperCase() && match !== match.toLowerCase() ? to.toUpperCase() : to));
}
