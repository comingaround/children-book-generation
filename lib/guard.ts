import 'server-only';

import { HOSTED } from './hosted';
import { HttpError } from './http-error';

/**
 * A daily cap on paid image calls for the public demo: per visitor (IP) and for the whole site.
 * Counted in the function's memory, so a new instance starts again from zero; the hard stop is
 * the budget on the Google project. Local runs are not limited.
 */

const PER_VISITOR = Number(process.env.DEMO_DAILY_IMAGES) || 30;
const PER_SITE = Number(process.env.DEMO_SITE_DAILY_IMAGES) || 300;

const g = globalThis as unknown as { imageCounts?: { day: string; visitors: Map<string, number>; site: number } };

/** Counts one image call for this request's visitor, or refuses it once a cap is reached. */
export function spendImage(req: Request): void {
  if (!HOSTED) return;
  const day = new Date().toISOString().slice(0, 10);
  if (g.imageCounts?.day !== day) g.imageCounts = { day, visitors: new Map(), site: 0 };
  const counts = g.imageCounts;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const used = counts.visitors.get(ip) ?? 0;
  if (used >= PER_VISITOR) throw new HttpError(429, `That's today's ${PER_VISITOR} free pictures for this demo — come back tomorrow`);
  if (counts.site >= PER_SITE) throw new HttpError(429, 'The demo has drawn all it can today — come back tomorrow');
  counts.visitors.set(ip, used + 1);
  counts.site++;
}
