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
 * Keeps the original everywhere except a soft-edged area around the hero's box, so the
 * background, other characters and colours stay pixel-identical to the book.
 */
export async function blendInBox(original: Buffer, edited: Buffer, box: Box, width: number, height: number): Promise<Buffer> {
  // Grow the box a little: the model often redraws hair or a hand just past it.
  const grow = 0.12;
  const x = Math.max(0, (box.x - box.w * grow) / 100) * width;
  const y = Math.max(0, (box.y - box.h * grow) / 100) * height;
  const x2 = Math.min(1, (box.x + box.w * (1 + grow)) / 100) * width;
  const y2 = Math.min(1, (box.y + box.h * (1 + grow)) / 100) * height;
  const feather = Math.max(4, Math.round(Math.min(width, height) * 0.015));

  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><filter id="f" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${feather}"/></filter></defs>
      <rect x="${x + feather}" y="${y + feather}" width="${Math.max(1, x2 - x - 2 * feather)}" height="${Math.max(1, y2 - y - 2 * feather)}" rx="${feather * 2}" fill="#fff" filter="url(#f)"/>
    </svg>`
  );
  const cutout = await sharp(edited).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  return sharp(original).composite([{ input: cutout }]).toBuffer();
}

// ---- close-up around the main character ----------------------------------------------

/** A rectangle in pixels of the art. */
export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
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
export const thumbnail = (input: Buffer, width = 480) => jpeg(sharp(input).rotate().resize(width, width * 2, { fit: 'inside', withoutEnlargement: true }));
