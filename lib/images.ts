import 'server-only';

import sharp, { type Sharp } from 'sharp';

import type { InlineImage } from './ai/gemini';
import type { Box } from './types';

/** Longest side sent to the model; larger only costs upload time. */
const MODEL_MAX = 2048;

/** Aspect ratios the image model can return. */
const RATIOS: [string, number][] = [
  ['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3],
  ['4:5', 4 / 5], ['5:4', 5 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9], ['21:9', 21 / 9],
];

const jpeg = (img: Sharp) => img.jpeg({ quality: 90, mozjpeg: true }).toBuffer();

/** Upright, downscaled JPEG for a model input. */
export async function forModel(input: Buffer, max = MODEL_MAX): Promise<InlineImage> {
  const data = await jpeg(sharp(input).rotate().resize(max, max, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }));
  return { data, mimeType: 'image/jpeg' };
}

export interface Padded {
  image: InlineImage;
  ratio: string;
  /** The original art's share of the padded frame, in 0–1, for cropping the answer back. */
  crop: { left: number; top: number; width: number; height: number };
}

/**
 * The model returns only fixed aspect ratios. Pad the art (mirrored, so the model sees no
 * hard edge) to the nearest one, and remember where the art sits so the answer can be
 * cropped back to the exact original shape instead of being stretched.
 */
export async function padToRatio(input: Buffer): Promise<Padded> {
  const small = await sharp(input).resize(MODEL_MAX, MODEL_MAX, { fit: 'inside', withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = small.info;
  const [ratio, value] = RATIOS.reduce((best, r) => (Math.abs(Math.log(r[1] / (w / h))) < Math.abs(Math.log(best[1] / (w / h))) ? r : best));

  const pw = Math.max(w, Math.round(h * value));
  const ph = Math.max(h, Math.round(w / value));
  const left = Math.floor((pw - w) / 2);
  const top = Math.floor((ph - h) / 2);
  const data = await jpeg(
    sharp(small.data)
      .extend({ left, right: pw - w - left, top, bottom: ph - h - top, extendWith: 'mirror' })
      .flatten({ background: '#ffffff' })
  );
  return { image: { data, mimeType: 'image/jpeg' }, ratio, crop: { left: left / pw, top: top / ph, width: w / pw, height: h / ph } };
}

/** Crops the model's answer back to the art's frame and scales it to the original size. */
export async function unpad(answer: Buffer, crop: Padded['crop'], width: number, height: number): Promise<Buffer> {
  const meta = await sharp(answer).metadata();
  const aw = meta.width ?? width;
  const ah = meta.height ?? height;
  return sharp(answer)
    .extract({
      left: Math.round(crop.left * aw),
      top: Math.round(crop.top * ah),
      width: Math.min(Math.round(crop.width * aw), aw - Math.round(crop.left * aw)),
      height: Math.min(Math.round(crop.height * ah), ah - Math.round(crop.top * ah)),
    })
    .resize(width, height, { fit: 'fill' })
    .toBuffer();
}

/**
 * Keeps the original everywhere except soft-edged areas around the characters' boxes, so the
 * background, other characters and colours stay pixel-identical to the book.
 */
export async function blendInBox(
  original: Buffer,
  edited: Buffer,
  boxes: Box[],
  width: number,
  height: number,
  grow = 0.12,
  /**
   * 'in': the soft edge lies inside each area (the close-up's own edge). 'out': every pixel of the
   * area is taken in full and the edge fades outside it, over the background: an inward edge
   * made new hair and glasses near it half transparent.
   */
  fade: 'in' | 'out' = 'in'
): Promise<Buffer> {
  const cutout = await sharp(edited).ensureAlpha().composite([{ input: areaMask(boxes, width, height, grow, fade), blend: 'dest-in' }]).png().toBuffer();
  return sharp(original).composite([{ input: cutout }]).toBuffer();
}

/** blendInBox's mask: white inside the (grown) areas, a soft edge inward or outward. An SVG. */
function areaMask(boxes: Box[], width: number, height: number, grow: number, fade: 'in' | 'out'): Buffer {
  const feather = Math.max(4, Math.round(Math.min(width, height) * 0.015));
  // Inward: the rect sits one feather inside the area. Outward: two feathers outside, so the blur
  // is still fully opaque at the area's own edge (a Gaussian reaches ~98% two sigmas in).
  const inset = fade === 'in' ? feather : -2 * feather;
  const rects = boxes.map((box) => {
    // Grow the box a little: the model often redraws hair or a hand just past it.
    const x = Math.max(0, (box.x - box.w * grow) / 100) * width;
    const y = Math.max(0, (box.y - box.h * grow) / 100) * height;
    const x2 = Math.min(1, (box.x + box.w * (1 + grow)) / 100) * width;
    const y2 = Math.min(1, (box.y + box.h * (1 + grow)) / 100) * height;
    return `<rect x="${x + inset}" y="${y + inset}" width="${Math.max(1, x2 - x - 2 * inset)}" height="${Math.max(1, y2 - y - 2 * inset)}" rx="${feather * 2}" fill="#fff"/>`;
  });
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${feather}"/></filter></defs>
      <g filter="url(#f)">${rects.join('')}</g>
    </svg>`
  );
}

/** One person on a see-through page: their pasted areas and their body (where strength is measured). */
export interface FadePerson {
  areas: Box[];
  body: Box;
}

/** Margin around a text box searched for its bubble, and the rectangle used when there is none, in %. */
const TEXT_PAD = 3;
/** How far an AI bubble drawn off the book's may reach and still be taken back, in %. */
const AI_BUBBLE_PAD = 10;

/**
 * Where a page's printed text must stay the book's own (keepText in draw.ts), as a one-channel
 * mask the size of the page (255 = the original). For a text box in a speech bubble: the bubble's
 * own shape, found in the original as the pale even colour around the letters, joined to the
 * letters from inside, letters filled in, widened a few pixels, and softened; plus any bubble the
 * AI drew off the book's (`result`, the redrawn page). What stands next to the bubble (new hair, a sleeve) stays the AI's.
 * Text with no bubble behind it (a cover title on the art): the box with a TEXT_PAD margin, as
 * before.
 */
export async function textMask(original: Buffer, result: Buffer, boxes: Box[], width: number, height: number): Promise<Buffer> {
  const o = await sharp(original).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const a = await sharp(result).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const mask = Buffer.alloc(width * height);
  const px = (b: Box) => ({
    x0: Math.max(0, Math.floor(((b.x - TEXT_PAD) / 100) * width)),
    y0: Math.max(0, Math.floor(((b.y - TEXT_PAD) / 100) * height)),
    x1: Math.min(width, Math.ceil(((b.x + b.w + TEXT_PAD) / 100) * width)),
    y1: Math.min(height, Math.ceil(((b.y + b.h + TEXT_PAD) / 100) * height)),
    tx0: Math.max(0, Math.floor((b.x / 100) * width)),
    ty0: Math.max(0, Math.floor((b.y / 100) * height)),
    tx1: Math.min(width, Math.ceil(((b.x + b.w) / 100) * width)),
    ty1: Math.min(height, Math.ceil(((b.y + b.h) / 100) * height)),
  });
  const lum = (j: number) => 0.299 * o[j] + 0.587 * o[j + 1] + 0.114 * o[j + 2];
  for (const box of boxes) {
    const r = px(box);
    // The bubble's colour: the lighter part of the text box (the letters are the darker part).
    const ls: number[] = [];
    for (let y = r.ty0; y < r.ty1; y += 2) for (let x = r.tx0; x < r.tx1; x += 2) ls.push(lum((y * width + x) * 3));
    ls.sort((a, b) => a - b);
    const cut = ls[Math.floor(ls.length * 0.6)] ?? 255;
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = r.ty0; y < r.ty1; y += 2) {
      for (let x = r.tx0; x < r.tx1; x += 2) {
        const j = (y * width + x) * 3;
        if (lum(j) < cut) continue;
        sum[0] += o[j];
        sum[1] += o[j + 1];
        sum[2] += o[j + 2];
        n++;
      }
    }
    const bubble = n ? sum.map((s) => s / n) : [255, 255, 255];
    const near = (px: Buffer, j: number) => Math.hypot(px[j] - bubble[0], px[j + 1] - bubble[1], px[j + 2] - bubble[2]) < 34;
    const like = (j: number) => near(o, j);
    let even = 0;
    let all = 0;
    for (let y = r.ty0; y < r.ty1; y += 2) for (let x = r.tx0; x < r.tx1; x += 2, all++) if (like((y * width + x) * 3)) even++;
    // No even, light background behind the letters: no bubble, the padded rectangle.
    if (!all || even / all < 0.55 || 0.299 * bubble[0] + 0.587 * bubble[1] + 0.114 * bubble[2] < 150) {
      for (let y = r.y0; y < r.y1; y++) mask.fill(255, y * width + r.x0, y * width + r.x1);
      continue;
    }
    // The bubble: pixels of the bubble's colour in the book OR in the answer, joined to the text
    // box (flood fill), within AI_BUBBLE_PAD: an AI bubble drawn a little off, with its own copy
    // of the letters, is taken back too (a 19 Nov answer drew its lettering beside the bubble),
    // while hair or clothes beside the bubble, never bubble-coloured, stay the AI's.
    const wide = px({ x: box.x - (AI_BUBBLE_PAD - TEXT_PAD), y: box.y - (AI_BUBBLE_PAD - TEXT_PAD), w: box.w + 2 * (AI_BUBBLE_PAD - TEXT_PAD), h: box.h + 2 * (AI_BUBBLE_PAD - TEXT_PAD) });
    Object.assign(r, { x0: wide.x0, y0: wide.y0, x1: wide.x1, y1: wide.y1 });
    const fill = (j: number) => near(o, j) || near(a, j);
    const bw = r.x1 - r.x0;
    const bh = r.y1 - r.y0;
    const seen = new Uint8Array(bw * bh);
    const stack: number[] = [];
    for (let y = r.ty0; y < r.ty1; y++) {
      for (let x = r.tx0; x < r.tx1; x++) {
        const k = (y - r.y0) * bw + (x - r.x0);
        if (!seen[k] && fill((y * width + x) * 3)) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % bw;
      const y = (k - x) / bw;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const nk = ny * bw + nx;
        if (seen[nk] || !fill(((ny + r.y0) * width + nx + r.x0) * 3)) continue;
        seen[nk] = 1;
        stack.push(nk);
      }
    }
    // Letters filled and the edge widened: a blur of the bubble, kept where it reaches 15%.
    const spread = Math.max(4, Math.min(width, height) * 0.006);
    const grown = await sharp(Buffer.from(seen.map((v) => v * 255)), { raw: { width: bw, height: bh, channels: 1 } })
      .blur(spread)
      .extractChannel(0)
      .raw()
      .toBuffer();
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const inTight = x + r.x0 >= r.tx0 && x + r.x0 < r.tx1 && y + r.y0 >= r.ty0 && y + r.y0 < r.ty1;
        if (inTight || grown[y * bw + x] > 38) mask[(y + r.y0) * width + x + r.x0] = 255;
      }
    }
  }
  // A soft edge of a few pixels.
  return sharp(mask, { raw: { width, height, channels: 1 } })
    .blur(Math.max(1.5, Math.min(width, height) * 0.0015))
    .extractChannel(0)
    .raw()
    .toBuffer();
}

/** `result` with `original` put back where `mask` (one channel, 0–255) says. A PNG. */
export async function keepOriginalIn(result: Buffer, original: Buffer, mask: Buffer): Promise<Buffer> {
  const { data: r, info } = await sharp(result).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = await sharp(original).resize(info.width, info.height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const out = Buffer.from(r);
  for (let i = 0, j = 0; i < mask.length; i++, j += 3) {
    const m = mask[i] / 255;
    if (!m) continue;
    for (let c = 0; c < 3; c++) out[j + c] = Math.round(r[j + c] + m * (o[j + c] - r[j + c]));
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}

/**
 * Free correction (no AI) for see-through pages: wherever the redrawn people are stronger than the
 * book's, band by band down each person, they are softened towards the paper. "Stronger" is how
 * far from the paper colour they sit, and how colourful, measured where the redraw changed the
 * picture (a new face and hair against the old ones; the untouched background doesn't count).
 * Softening keeps every colour's direction, so a dark-skinned child stays darker than a fair one,
 * and it only ever softens: deep black hair turns milky, a strong red calms, while what already
 * matches is left alone. Noah & Lina page 12: faded with the original's strength, the girl's
 * black bob still read as a solid patch over a book drawn in soft browns.
 */
export async function softenToOriginal(original: Buffer, drawn: Buffer, people: FadePerson[]): Promise<{ image: Buffer; profiles: { ink: number; colour: number }[][] }> {
  const { data: d, info } = await sharp(drawn).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const o = await sharp(original).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  // The paper: the light, nearly colourless part of the original.
  const paper = [0, 0, 0];
  let papers = 0;
  for (let j = 0; j < o.length; j += 3 * 7) {
    const [r, g, b] = [o[j], o[j + 1], o[j + 2]];
    if (0.299 * r + 0.587 * g + 0.114 * b > 205 && Math.max(r, g, b) - Math.min(r, g, b) < 25) {
      paper[0] += r;
      paper[1] += g;
      paper[2] += b;
      papers++;
    }
  }
  const [pr, pg, pb] = papers > 100 ? paper.map((c) => c / papers) : [244, 241, 234];
  // Where the redraw changed the picture, in broad patches (the same blur as fadePeople).
  const diff = Buffer.alloc(width * height);
  for (let i = 0, j = 0; i < diff.length; i++, j += 3) diff[i] = Math.max(Math.abs(d[j] - o[j]), Math.abs(d[j + 1] - o[j + 1]), Math.abs(d[j + 2] - o[j + 2]));
  const broad = await sharp(diff, { raw: { width, height, channels: 1 } }).blur(Math.max(2, Math.min(width, height) * 0.006)).extractChannel(0).raw().toBuffer();
  const ink = (a: Buffer, j: number) => Math.hypot(a[j] - pr, a[j + 1] - pg, a[j + 2] - pb);
  const colour = (a: Buffer, j: number) => Math.max(a[j], a[j + 1], a[j + 2]) - Math.min(a[j], a[j + 1], a[j + 2]);

  const keep = new Float32Array(width * height).fill(1);
  const calm = new Float32Array(width * height).fill(1);
  const profiles: { ink: number; colour: number }[][] = [];
  for (const person of people) {
    const inArea = await sharp(areaMask(person.areas, width, height, 0, 'out')).resize(width, height).ensureAlpha().extractChannel(3).raw().toBuffer();
    // The whole person, crown to feet, in bands.
    const top = (Math.min(...person.areas.map((a) => a.y)) / 100) * height;
    const bottom = (Math.max(...person.areas.map((a) => a.y + a.h)) / 100) * height;
    const bandHeight = (bottom - top) / FADE_BANDS;
    const sums = Array.from({ length: FADE_BANDS }, () => ({ w: 0, io: 0, id: 0, co: 0, cd: 0 }));
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.ceil(bottom)); y++) {
      const s = sums[Math.min(FADE_BANDS - 1, Math.max(0, Math.floor((y - top) / bandHeight)))];
      for (let x = 0, i = y * width; x < width; x++, i++) {
        const w = (inArea[i] / 255) * Math.min(1, Math.max(0, (broad[i] - 8) / 16));
        if (!w) continue;
        const j = i * 3;
        s.w += w;
        s.io += w * ink(o, j);
        s.id += w * ink(d, j);
        s.co += w * colour(o, j);
        s.cd += w * colour(d, j);
      }
    }
    // Per band: how much of the way from the paper to keep (ink), then how much colour to keep.
    // Too little changed in a band to tell: left as drawn. Never below ~half, never stronger.
    const enough = (width * height) / 4000;
    const raw = sums.map((s) => {
      if (s.w < enough || !s.id) return { ink: 1, colour: 1 };
      const k = Math.min(1, Math.max(0.55, s.io / s.id));
      const c = s.cd ? Math.min(1, Math.max(0.4, s.co / (k * s.cd))) : 1;
      return { ink: k, colour: c };
    });
    const smooth = raw.map((r, b) => {
      const n = (f: (q: { ink: number; colour: number }) => number) => (f(raw[Math.max(0, b - 1)]) + 2 * f(r) + f(raw[Math.min(FADE_BANDS - 1, b + 1)])) / 4;
      return { ink: n((q) => q.ink), colour: n((q) => q.colour) };
    });
    profiles.push(smooth);
    const last = FADE_BANDS - 1;
    for (let y = 0; y < height; y++) {
      const at = Math.min(last, Math.max(0, (y - top) / bandHeight - 0.5));
      const b = Math.floor(at);
      const t = at - b;
      const k = smooth[b].ink + (smooth[Math.min(last, b + 1)].ink - smooth[b].ink) * t;
      const c = smooth[b].colour + (smooth[Math.min(last, b + 1)].colour - smooth[b].colour) * t;
      for (let x = 0, i = y * width; x < width; x++, i++) {
        if (!inArea[i]) continue;
        const m = inArea[i] / 255;
        keep[i] = Math.min(keep[i], 1 - m * (1 - k));
        calm[i] = Math.min(calm[i], 1 - m * (1 - c));
      }
    }
  }
  const out = Buffer.from(d);
  for (let i = 0, j = 0; i < keep.length; i++, j += 3) {
    if (keep[i] === 1 && calm[i] === 1) continue;
    const r = pr + keep[i] * (d[j] - pr);
    const g = pg + keep[i] * (d[j + 1] - pg);
    const b = pb + keep[i] * (d[j + 2] - pb);
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    out[j] = Math.round(Math.min(255, Math.max(0, l + calm[i] * (r - l))));
    out[j + 1] = Math.round(Math.min(255, Math.max(0, l + calm[i] * (g - l))));
    out[j + 2] = Math.round(Math.min(255, Math.max(0, l + calm[i] * (b - l))));
  }
  return { image: await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer(), profiles };
}

/** Below this share of the drawn people's colour and contrast, the original's people count as faded. */
const FADED_BELOW = 0.7;

/**
 * Free check (no AI) whether a page's people are see-through in the original although the page
 * isn't marked so: a redraw keeps the clothes, so on an ordinary page the original's bodies are
 * as colourful and contrasty as the drawn ones (Noah & Lina: 0.87–1.14 on 12 pages), while
 * solid people drawn over faded ones are about twice as strong (page 12: ~0.5). Both colour and
 * contrast must be low for some person, since a redraw can change one of them (page 11: 1.37 and
 * 0.75). Returns the lower of the two per person, for the log.
 */
export async function looksFaded(original: Buffer, drawn: Buffer, bodies: Box[]): Promise<{ faded: boolean; strength: number[] }> {
  const S = 512;
  const rgb = (b: Buffer) => sharp(b).resize(S, S, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [o, d] = await Promise.all([rgb(original), rgb(drawn)]);
  const measure = (px: Buffer, inside: Uint8Array) => {
    let chroma = 0;
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let i = 0; i < S * S; i++) {
      if (!inside[i]) continue;
      const [r, g, b] = [px[i * 3], px[i * 3 + 1], px[i * 3 + 2]];
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += l;
      sq += l * l;
      n++;
    }
    return n ? { chroma: chroma / n, contrast: Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) } : null;
  };
  const strength = bodies.map((body) => {
    const inside = areaGrid([body], S);
    const [a, b] = [measure(o, inside), measure(d, inside)];
    if (!a || !b || !b.chroma || !b.contrast) return 1;
    return Math.min(a.chroma / b.chroma, a.contrast / b.contrast) < FADED_BELOW ? Math.max(a.chroma / b.chroma, a.contrast / b.contrast) : 1;
  });
  return { faded: strength.some((s) => s < FADED_BELOW), strength };
}

/** Bands down a body, each measured on its own: a faded figure is often solid at the top and gone at the feet. */
const FADE_BANDS = 6;

/**
 * How solid the original's people are, measured instead of guessed, per person and per band down
 * their body (the clothes, which a redraw keeps; a face is a different person and can't be
 * compared). In each band the original sits at plate + a × (drawn − plate), the plate being the
 * same picture without the people; `a` is the least-squares fit. Noah & Lina page 12 was guessed
 * at one 65% and came out about twice as vivid as the book; measured, the book's people are near
 * solid at the chest and fade out towards the shoes. A band with too little to tell takes its
 * neighbours' value; null for a person with no band to tell from. `drawn` can also be a faded
 * version: the profile is then how much further it needs to fade (refadePageStep).
 */
export async function measureOpacity(original: Buffer, drawn: Buffer, plate: Buffer, people: FadePerson[]): Promise<(number[] | null)[]> {
  const S = 256;
  const rgb = (b: Buffer) => sharp(b).resize(S, S, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [o, d, p] = await Promise.all([rgb(original), rgb(drawn), rgb(plate)]);
  return people.map(({ body }) => {
    const inside = areaGrid([body], S);
    const top = (body.y / 100) * S;
    const height = (body.h / 100) * S;
    const num = new Array<number>(FADE_BANDS).fill(0);
    const den = new Array<number>(FADE_BANDS).fill(0);
    const count = new Array<number>(FADE_BANDS).fill(0);
    for (let i = 0; i < S * S; i++) {
      if (!inside[i]) continue;
      let dd = 0;
      for (let c = 0; c < 3; c++) dd = Math.max(dd, Math.abs(d[i * 3 + c] - p[i * 3 + c]));
      // Only where the drawn person clearly stands out from the background behind them.
      if (dd < 30) continue;
      const band = Math.min(FADE_BANDS - 1, Math.max(0, Math.floor(((Math.floor(i / S) + 0.5 - top) / height) * FADE_BANDS)));
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c;
        num[band] += (o[j] - p[j]) * (d[j] - p[j]);
        den[band] += (d[j] - p[j]) ** 2;
      }
      count[band]++;
    }
    const measured = num.map((n, b) => (count[b] >= 40 && den[b] ? Math.min(1, Math.max(0.1, n / den[b])) : null));
    if (measured.every((a) => a === null)) return null;
    // Gaps take the nearest measured band; then a light 1-2-1 smoothing, so no band edge shows.
    const filled = measured.map((a, b) => {
      if (a !== null) return a;
      for (let k = 1; k < FADE_BANDS; k++) {
        const near = measured[b - k] ?? measured[b + k];
        if (near !== null && near !== undefined) return near;
      }
      return 1;
    });
    return filled.map((a, b) => (filled[Math.max(0, b - 1)] + 2 * a + filled[Math.min(FADE_BANDS - 1, b + 1)]) / 4);
  });
}

/**
 * Fades drawn people to a see-through page's strength: plate + opacity × (drawn − plate), where
 * the plate is the same picture with them removed. Each person by their own profile down their
 * body (measureOpacity; above the body, the head and hair take the top band's value), inside
 * their areas with the paste's soft edge, and only where the people differ from the plate in a
 * broad patch: where they match (the paper, lettering across them) nothing changes, and a thin
 * line the plate drew a few pixels off is left alone instead of ghosting. A PNG the size of `drawn`.
 */
export async function fadePeople(drawn: Buffer, plate: Buffer, people: (FadePerson & { profile: number[] })[]): Promise<Buffer> {
  const { data: d, info } = await sharp(drawn).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const p = await sharp(plate).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const diff = Buffer.alloc(width * height);
  for (let i = 0, j = 0; i < diff.length; i++, j += 3) diff[i] = Math.max(Math.abs(d[j] - p[j]), Math.abs(d[j + 1] - p[j + 1]), Math.abs(d[j + 2] - p[j + 2]));
  // A blur of ~0.6% of the picture: a 2-px line 100 levels off spreads to under 10, a body stays high.
  // extractChannel: sharp hands a one-channel blur back as three channels, which read one byte a
  // pixel put the top third of the picture's differences over the whole of it.
  const broad = await sharp(diff, { raw: { width, height, channels: 1 } }).blur(Math.max(2, Math.min(width, height) * 0.006)).extractChannel(0).raw().toBuffer();
  // How much of the way to the plate each pixel goes: the most any person asks for there.
  const toPlate = new Float32Array(width * height);
  for (const person of people) {
    // The mask is white on transparent: its shape is the alpha channel (greyscale() keeps alpha,
    // two bytes a pixel, and read as one it faded only part of the body).
    const inArea = await sharp(areaMask(person.areas, width, height, 0, 'out')).resize(width, height).ensureAlpha().extractChannel(3).raw().toBuffer();
    const top = (person.body.y / 100) * height;
    const bandHeight = ((person.body.h / 100) * height) / person.profile.length;
    const last = person.profile.length - 1;
    for (let y = 0; y < height; y++) {
      // Band centres interpolated, so the strength changes smoothly down the body.
      const at = Math.min(last, Math.max(0, (y - top) / bandHeight - 0.5));
      const b = Math.floor(at);
      const opacity = person.profile[b] + (person.profile[Math.min(last, b + 1)] - person.profile[b]) * (at - b);
      for (let x = 0, i = y * width; x < width; x++, i++) {
        if (!inArea[i]) continue;
        toPlate[i] = Math.max(toPlate[i], (inArea[i] / 255) * (1 - opacity));
      }
    }
  }
  const out = Buffer.from(d);
  for (let i = 0, j = 0; i < broad.length; i++, j += 3) {
    const w = toPlate[i] * Math.min(1, Math.max(0, (broad[i] - 10) / 20));
    if (!w) continue;
    for (let c = 0; c < 3; c++) out[j + c] = Math.round(d[j + c] - w * (d[j + c] - p[j + c]));
  }
  return sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** How a person's hair sits, from their approved drawing (draw.ts hairOf): sizes the areas below. */
export interface HairFit {
  /** How far the hair stands out from the head. */
  volume: 'close' | 'medium' | 'big';
  /** How far down it falls. */
  reach: 'above-chin' | 'shoulders' | 'below-shoulders';
}

/**
 * What of a character box to take from a redraw, in % of an image `width` x `height` px: the areas
 * pasted back, and the body area alone. The box outlines the book's original character; the new
 * person's hair can be bigger or longer, and a head can land a little off, so the head gets room
 * around it, as much as THIS person's hair needs (`hair`, from their drawing): tight for short hair,
 * down the sides for long hair. A fixed 25% (at least 60 px) for everyone carried the AI's changes
 * to what stands beside a short-haired child (a dragon toy cut in half, Noah & Lina page 4); without
 * `hair` that is still the rule. The body part stays close (9%, at least 20 px), so little of what
 * they touch is taken from the AI. Already grown: blend with grow = 0, fade 'out'.
 */
export function personAreas(box: Box, width: number, height: number, hair?: HairFit): { areas: Box[]; body: Box } {
  const headShare = 0.45;
  const bw = (box.w / 100) * width;
  const bh = (box.h / 100) * height;
  const headSize = Math.max(bw, bh * headShare);
  const headPad = hair ? Math.max({ close: 24, medium: 40, big: 60 }[hair.volume], headSize * { close: 0.1, medium: 0.18, big: 0.3 }[hair.volume]) : Math.max(60, headSize * 0.25);
  const bodyPadX = Math.max(20, bw * 0.09);
  const bodyPadY = Math.max(20, bh * 0.09);
  const area = (x0: number, y0: number, x1: number, y1: number): Box => {
    const x = Math.max(0, x0);
    const y = Math.max(0, y0);
    return { x, y, w: Math.min(100, x1) - x, h: Math.min(100, y1) - y };
  };
  const hx = (headPad / width) * 100;
  const hy = (headPad / height) * 100;
  const bx = (bodyPadX / width) * 100;
  const by = (bodyPadY / height) * 100;
  const body = area(box.x - bx, box.y + box.h * headShare, box.x + box.w + bx, box.y + box.h + by);
  if (!hair) return { areas: [area(box.x - hx, box.y - hy, box.x + box.w + hx, box.y + box.h * headShare + hy), body], body };
  // The hair's room runs down the sides as far as the hair falls (share of the box's height);
  // below it, down to the body, only the close body margin.
  const hairEnd = { 'above-chin': 0.3, shoulders: 0.45, 'below-shoulders': 0.75 }[hair.reach];
  const crown = area(box.x - hx, box.y - hy, box.x + box.w + hx, box.y + box.h * hairEnd);
  const neck = hairEnd < headShare ? [area(box.x - bx, box.y + box.h * hairEnd, box.x + box.w + bx, box.y + box.h * headShare)] : [];
  return { areas: [crown, ...neck, body], body };
}

/** The smallest box around several boxes. */
export function unionBox(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

/** Keeps nearly a whole close-up, fading only its edge, so it melts into the page. */
export const EDGE_FEATHER: Box = { x: 3, y: 3, w: 94, h: 94 };

// ---- close-up around the characters -------------------------------------------------

/** A rectangle in pixels of the art. */
export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A box (percent of the art) as whole pixels, always inside the art. */
export function boxRegion(box: Box, width: number, height: number): Region {
  const left = Math.min(Math.max(Math.round((box.x / 100) * width), 0), width - 1);
  const top = Math.min(Math.max(Math.round((box.y / 100) * height), 0), height - 1);
  return {
    left,
    top,
    width: Math.max(1, Math.min(Math.round((box.w / 100) * width), width - left)),
    height: Math.max(1, Math.min(Math.round((box.h / 100) * height), height - top)),
  };
}

/**
 * The area sent to the model instead of the whole page: the box plus a generous margin, so the
 * model still sees what the character is doing and where. At least 30% of the shorter side,
 * so a tiny figure still comes with some of its surroundings.
 */
export function closeUpRegion(box: Box, width: number, height: number): Region {
  const bx = (box.x / 100) * width;
  const by = (box.y / 100) * height;
  const bw = (box.w / 100) * width;
  const bh = (box.h / 100) * height;
  const margin = Math.max(bw, bh) * 0.6;
  const min = Math.min(width, height) * 0.3;

  // Grow around the centre, then slide back inside the art if it pokes out. Round first and
  // clamp after, so start + length can never pass the edge by a rounding pixel.
  const span = (start: number, size: number, limit: number) => {
    const length = Math.max(1, Math.min(Math.round(Math.max(size + 2 * margin, min)), limit));
    const from = Math.min(Math.max(Math.round(start + size / 2 - length / 2), 0), limit - length);
    return [from, length];
  };
  const [left, w] = span(bx, bw, width);
  const [top, h] = span(by, bh, height);
  return { left, top, width: w, height: h };
}

/** The box in percent of a region instead of the whole art. */
export function boxInRegion(box: Box, region: Region, width: number, height: number): Box {
  return {
    x: (((box.x / 100) * width - region.left) / region.width) * 100,
    y: (((box.y / 100) * height - region.top) / region.height) * 100,
    w: (((box.w / 100) * width) / region.width) * 100,
    h: (((box.h / 100) * height) / region.height) * 100,
  };
}

/** Cuts a region out, enlarged to at least `min` px on its long side so the model sees detail. */
export async function cutRegion(art: Buffer, region: Region, min = 1280): Promise<Buffer> {
  const cut = sharp(art).extract(region);
  const long = Math.max(region.width, region.height);
  return long < min ? cut.resize({ width: Math.round((region.width / long) * min), kernel: 'lanczos3' }).png().toBuffer() : cut.png().toBuffer();
}

/** Puts an edited region (already at the region's size) back into the art. */
export const pasteRegion = (art: Buffer, edited: Buffer, region: Region) =>
  sharp(art).composite([{ input: edited, left: region.left, top: region.top }]).toBuffer();

/**
 * The head and all of the hair of a standing character drawing (the top part of the frame, at
 * least 40%). Pages get only this, so the model can take face, hair and skin from it but has
 * little outfit to copy.
 */
export async function headOf(drawing: Buffer, hairBottom = 0): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(drawing).metadata();
  // Down to the end of the hair (`hairBottom`, 0–1 of the drawing's height): cut at the chin, a
  // ponytail over the shoulder was never seen, and every page guessed a different hairstyle.
  const share = Math.min(1, Math.max(0.4, hairBottom + 0.04));
  return sharp(drawing).extract({ left: 0, top: 0, width, height: Math.round(height * share) }).toBuffer();
}

export const toJpeg = (input: Buffer) => jpeg(sharp(input).flatten({ background: '#ffffff' }));

/** Small JPEG for strips and cards. */
export const thumbnail = (input: Buffer, width = 720) => jpeg(sharp(input).rotate().resize(width, width * 2, { fit: 'inside', withoutEnlargement: true }));

/** Resampled (Lanczos) so it is at least `width` px wide, for print; already-large art is left as is. */
export async function upscaleTo(input: Buffer, width: number): Promise<Buffer | null> {
  const meta = await sharp(input).metadata();
  if (!meta.width || meta.width >= width) return null;
  return sharp(input).resize({ width, kernel: 'lanczos3' }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

/** Pixels of `areas` (% of the image) on an S x S grid: 1 = inside. */
function areaGrid(areas: Box[], S: number): Uint8Array {
  const grid = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = ((x + 0.5) / S) * 100;
      const py = ((y + 0.5) / S) * 100;
      if (areas.some((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)) grid[y * S + x] = 1;
    }
  }
  return grid;
}

/**
 * Removes the AI's colour cast, the red halo around and on the people. Colour levels only: no
 * shape, face or expression is touched. Two steps, both measured where the answer should match the
 * original exactly:
 *  1. the background outside `areas`: each channel's shift (and contrast, clamped to ±10%) is
 *     undone on the whole answer;
 *  2. each person's clothes (the lower part of their box, `bodies`): pixels the AI barely changed
 *     (within 40 per channel) show the cast left on that person; each channel's median shift is
 *     undone inside that person's areas, face included. Clamped to ±25; under 2 is noise.
 * A step is skipped when too little is visible to measure.
 */
export async function removeCast(original: Buffer, answer: Buffer, areas: Box[], people: { areas: Box[]; body: Box }[]): Promise<Buffer> {
  const meta = await sharp(answer).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const S = 256;
  const small = (b: Buffer) => sharp(b).resize(S, S, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [o, a0] = await Promise.all([small(original), small(answer)]);

  // 1 · background
  const inside = areaGrid(areas, S);
  const stats = [0, 1, 2].map(() => ({ so: 0, sa: 0, qo: 0, qa: 0 }));
  let n = 0;
  for (let i = 0; i < S * S; i++) {
    if (inside[i]) continue;
    n++;
    for (let c = 0; c < 3; c++) {
      const vo = o[i * 3 + c];
      const va = a0[i * 3 + c];
      stats[c].so += vo;
      stats[c].sa += va;
      stats[c].qo += vo * vo;
      stats[c].qa += va * va;
    }
  }
  let gain = [1, 1, 1];
  let offset = [0, 0, 0];
  if (n >= S * S * 0.12) {
    gain = [];
    offset = [];
    for (const { so, sa, qo, qa } of stats) {
      const mo = so / n;
      const ma = sa / n;
      const sdo = Math.sqrt(Math.max(qo / n - mo * mo, 1));
      const sda = Math.sqrt(Math.max(qa / n - ma * ma, 1));
      const g = Math.min(1.1, Math.max(0.9, sdo / sda));
      gain.push(g);
      offset.push(mo - ma * g);
    }
  }
  const level = (v: number, c: number) => v * gain[c] + offset[c];

  // 2 · each person, from their clothes
  const casts = people.map((p) => {
    const body = areaGrid([p.body], S);
    const diffs: number[][] = [[], [], []];
    let total = 0;
    for (let i = 0; i < S * S; i++) {
      if (!body[i]) continue;
      total++;
      const d = [0, 1, 2].map((c) => level(a0[i * 3 + c], c) - o[i * 3 + c]);
      if (Math.max(...d.map(Math.abs)) < 40) d.forEach((v, c) => diffs[c].push(v));
    }
    // Only when the clothes really are the book's (80% of the body area matches): where the AI
    // moved or redrew the person, the "cast" measured on them is nonsense, and undoing it painted a
    // purple patch over Mama (Noah & Lina page 4, 19 Nov).
    if (diffs[0].length < 100 || diffs[0].length < total * 0.8) return [0, 0, 0];
    return diffs.map((list) => {
      const m = list.sort((x, y) => x - y)[list.length >> 1];
      return Math.abs(m) < 2 ? 0 : -Math.max(-25, Math.min(25, m));
    });
  });

  const rgb = await sharp(answer).removeAlpha().raw().toBuffer();
  const out = Buffer.alloc(W * H * 3);
  const personAt = (px: number, py: number) =>
    people.findIndex((p) => p.areas.some((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = personAt(((x + 0.5) / W) * 100, ((y + 0.5) / H) * 100);
      const i = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v = level(rgb[i + c], c) + (k < 0 ? 0 : casts[k][c]);
        out[i + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/**
 * How far the AI moved the scene: the mean grey-level difference between the original and the
 * answer outside `areas` (the people, % of the image), both shrunk to 96 px and blurred, so texture
 * and brushwork don't count but a zoom, a reframe or a redrawn room does. null when too little of
 * the picture is outside the people to judge.
 */
export async function sceneDrift(original: Buffer, answer: Buffer, areas: Box[]): Promise<number | null> {
  const S = 96;
  const grey = (b: Buffer) => sharp(b).removeAlpha().resize(S, S, { fit: 'fill' }).greyscale().blur(1.5).raw().toBuffer();
  const [a, b] = await Promise.all([grey(original), grey(answer)]);
  const inside = areaGrid(areas, S);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < S * S; i++) {
    if (inside[i]) continue;
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  return n < S * S * 0.12 ? null : sum / n;
}

/**
 * How far the AI moved the people themselves: the same blurred difference, inside each person's
 * body (the lower 55% of their box, so new hair and faces don't count), the worst person. The
 * scene check alone missed answers that kept the room but re-posed everyone (Noah & Lina page 4:
 * scene 4.9, people 40–53; the pages the owner approved stayed under 17). `exclude`: where long
 * hair may now fall (a ponytail over the chest, curls down the back where the original had a bun)
 * is no sign of anyone moving; without it, Noah & Lina pages 9 and 11 were rejected every time.
 */
export async function peopleDrift(original: Buffer, answer: Buffer, boxes: Box[], exclude: Box[] = []): Promise<number> {
  const S = 96;
  const grey = (b: Buffer) => sharp(b).removeAlpha().resize(S, S, { fit: 'fill' }).greyscale().blur(1.5).raw().toBuffer();
  const [a, b] = await Promise.all([grey(original), grey(answer)]);
  let worst = 0;
  for (const box of boxes) {
    const body = areaGrid([{ x: box.x, y: box.y + box.h * 0.45, w: box.w, h: box.h * 0.55 }], S);
    const skip = areaGrid(exclude, S);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < S * S; i++) {
      if (!body[i] || skip[i]) continue;
      sum += Math.abs(a[i] - b[i]);
      n++;
    }
    if (n > 20) worst = Math.max(worst, sum / n);
  }
  return worst;
}
