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
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${feather}"/></filter></defs>
      <g filter="url(#f)">${rects.join('')}</g>
    </svg>`
  );
  const cutout = await sharp(edited).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  return sharp(original).composite([{ input: cutout }]).toBuffer();
}

/**
 * What of a character box to take from a redraw, in % of an image `width` x `height` px. The box
 * outlines the book's original character, but the new person's hair or glasses can be bigger, and
 * a head can land a little off: the head part gets 25% of the head's size around it, never less
 * than 60 px (a small figure got ~7 px before). The body part stays close (9%, at least 20 px), so
 * little of what they touch is taken from the AI. Already grown: blend with grow = 0, fade 'out'.
 */
export function personAreas(box: Box, width: number, height: number): Box[] {
  const headShare = 0.45;
  const px = (pctW: number, pctH: number) => [(pctW / 100) * width, (pctH / 100) * height] as const;
  const [bw, bh] = px(box.w, box.h);
  const headSize = Math.max(bw, bh * headShare);
  const headPad = Math.max(60, headSize * 0.25);
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
  return [
    area(box.x - hx, box.y - hy, box.x + box.w + hx, box.y + box.h * headShare + hy),
    area(box.x - bx, box.y + box.h * headShare, box.x + box.w + bx, box.y + box.h + by),
  ];
}

/**
 * How far the AI moved the scene: the mean grey-level difference between the original and the
 * AI's answer outside `areas` (the people, % of the region), both shrunk to 96 px and blurred, so
 * texture and brushwork don't count but a zoom, a reframe or a redrawn room does. null when too
 * little of the picture is outside the people to judge (a close-up of faces).
 */
export async function sceneDrift(original: Buffer, answer: Buffer, areas: Box[]): Promise<number | null> {
  const S = 96;
  const grey = (b: Buffer) => sharp(b).resize(S, S, { fit: 'fill' }).greyscale().blur(1.5).raw().toBuffer();
  const [a, b] = await Promise.all([grey(original), grey(answer)]);
  let sum = 0;
  let n = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = ((x + 0.5) / S) * 100;
      const py = ((y + 0.5) / S) * 100;
      if (areas.some((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)) continue;
      sum += Math.abs(a[y * S + x] - b[y * S + x]);
      n++;
    }
  }
  return n < S * S * 0.12 ? null : sum / n;
}

/** Pixels of `areas` (% of the image) on an S x S grid: true = inside. */
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
 * Removes the AI's colour cast: its answer came back a little redder (red +2–3, green −2) around
 * the people, a halo where it was pasted. The background outside `areas` should be identical in
 * both, so each channel's shift (and contrast, clamped to ±10%) is measured there and undone on
 * the whole answer, faces included. Unchanged when too little background is visible to measure.
 */
export async function matchColours(original: Buffer, answer: Buffer, areas: Box[]): Promise<Buffer> {
  const S = 256;
  const small = (b: Buffer) => sharp(b).resize(S, S, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [o, a] = await Promise.all([small(original), small(answer)]);
  const inside = areaGrid(areas, S);
  const stats = [0, 1, 2].map(() => ({ so: 0, sa: 0, qo: 0, qa: 0 }));
  let n = 0;
  for (let i = 0; i < S * S; i++) {
    if (inside[i]) continue;
    n++;
    for (let c = 0; c < 3; c++) {
      const vo = o[i * 3 + c];
      const va = a[i * 3 + c];
      stats[c].so += vo;
      stats[c].sa += va;
      stats[c].qo += vo * vo;
      stats[c].qa += va * va;
    }
  }
  if (n < S * S * 0.12) return answer;
  const gain: number[] = [];
  const offset: number[] = [];
  for (const { so, sa, qo, qa } of stats) {
    const mo = so / n;
    const ma = sa / n;
    const sdo = Math.sqrt(Math.max(qo / n - mo * mo, 1));
    const sda = Math.sqrt(Math.max(qa / n - ma * ma, 1));
    const g = Math.min(1.1, Math.max(0.9, sdo / sda));
    gain.push(g);
    offset.push(mo - ma * g);
  }
  return sharp(answer).removeAlpha().linear(gain, offset).png().toBuffer();
}

/** One person on a page: the head part (all changes taken) and the body part (bare skin only). */
export interface PersonArea {
  head: Box;
  body: Box;
}

/** A pixel that can be skin: warm (red over green over blue), not too dark or grey. */
const skinLike = (r: number, g: number, b: number) => r > 70 && r >= g && g >= b - 8 && r - b > 18;

/** The median skin colour among skin-like pixels inside `grid`, or null if too few. */
function skinTone(px: Buffer, grid: Uint8Array): [number, number, number] | null {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i]) continue;
    const r = px[i * 3];
    const g = px[i * 3 + 1];
    const b = px[i * 3 + 2];
    if (!skinLike(r, g, b)) continue;
    rs.push(r);
    gs.push(g);
    bs.push(b);
  }
  if (rs.length < 30) return null;
  const mid = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
  return [mid(rs), mid(gs), mid(bs)];
}

/**
 * Pastes what the AI should change and nothing else. Head part: every pixel the AI changed (new
 * face, hair, skin, glasses), with a margin. Body part: bare skin only (hands, arms), recognised by
 * each person's own tone (the new face's skin in the answer, the old face's skin in the original),
 * taken where it is skin in either picture so no sliver of the old skin is left around new
 * fingers. Clothes and objects on the body always stay the book's own (the AI once repainted a
 * pyjama pattern). Soft edges everywhere. Run matchColours first, or the cast counts as a change.
 */
export async function blendPeople(original: Buffer, edited: Buffer, people: PersonArea[], width: number, height: number): Promise<Buffer> {
  const S = 512;
  const small = (b: Buffer) => sharp(b).resize(S, S, { fit: 'fill' }).removeAlpha().blur(1).raw().toBuffer();
  const [o, e] = await Promise.all([small(original), small(edited)]);
  const allowed = areaGrid(people.flatMap((p) => [p.head, p.body]), S);
  const THRESHOLD = 20;
  const SKIN_DISTANCE = 42;
  const near = (px: Buffer, i: number, tone: [number, number, number] | null) =>
    !!tone && skinLike(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]) && Math.hypot(px[i * 3] - tone[0], px[i * 3 + 1] - tone[1], px[i * 3 + 2] - tone[2]) < SKIN_DISTANCE;

  let take = new Uint8Array(S * S);
  for (const person of people) {
    const head = areaGrid([person.head], S);
    const body = areaGrid([person.body], S);
    const newSkin = skinTone(e, head);
    const oldSkin = skinTone(o, head);
    for (let i = 0; i < S * S; i++) {
      if (head[i]) {
        const d = Math.max(Math.abs(o[i * 3] - e[i * 3]), Math.abs(o[i * 3 + 1] - e[i * 3 + 1]), Math.abs(o[i * 3 + 2] - e[i * 3 + 2]));
        if (d > THRESHOLD) take[i] = 1;
      } else if (body[i] && (near(e, i, newSkin) || near(o, i, oldSkin))) {
        take[i] = 1;
      }
    }
  }
  // A margin around what is taken, so hair tips, glasses rims and finger edges are never nibbled.
  const R = Math.max(3, Math.round(S * 0.008));
  for (const horizontal of [true, false]) {
    const next = new Uint8Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (!take[y * S + x]) continue;
        for (let k = -R; k <= R; k++) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          if (xx >= 0 && xx < S && yy >= 0 && yy < S && allowed[yy * S + xx]) next[yy * S + xx] = 1;
        }
      }
    }
    take = next;
  }
  const alpha = Buffer.alloc(S * S);
  for (let i = 0; i < S * S; i++) alpha[i] = take[i] ? 255 : 0;
  const feather = Math.max(2, Math.round(Math.min(width, height) * 0.005));
  const mask = await sharp(alpha, { raw: { width: S, height: S, channels: 1 } })
    .resize(width, height, { fit: 'fill', kernel: 'cubic' })
    .blur(feather)
    .toColourspace('b-w')
    .raw()
    .toBuffer();
  // RGBA built by hand: joinChannel with a raw mask silently dropped it (3 channels came back), so
  // the whole AI close-up was pasted instead of the cut-out.
  const rgb = await sharp(edited).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = mask[i];
  }
  const cutout = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return sharp(original).composite([{ input: cutout }]).toBuffer();
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
 * Head and shoulders of a standing character drawing (the top part of the frame). Pages get
 * only this, so the model can take face, hair and skin from it but has no outfit to copy.
 */
export async function headOf(drawing: Buffer): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(drawing).metadata();
  return sharp(drawing).extract({ left: 0, top: 0, width, height: Math.round(height * 0.4) }).toBuffer();
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
