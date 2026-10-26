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

/** Swaps the hero's name for the child's in page text, keeping ALL-CAPS where the book used it. */
export function swapName(text: string, from: string, to: string): string {
  const name = from.trim();
  if (!name || !to.trim()) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), (match) => (match === match.toUpperCase() && match !== match.toLowerCase() ? to.toUpperCase() : to));
}
