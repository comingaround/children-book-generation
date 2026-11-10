// Copies the files pdf.js loads at runtime (image decoders, CMaps, colour profiles, standard
// fonts) to public/pdfjs/, so the browser import (lib/local/import.ts) can fetch them. Runs on
// every `npm install` (postinstall), here and on Vercel; public/pdfjs/ is not in git.

import { cpSync, rmSync } from 'node:fs';

rmSync('public/pdfjs', { recursive: true, force: true });
for (const dir of ['wasm', 'cmaps', 'iccs', 'standard_fonts']) {
  cpSync(`node_modules/pdfjs-dist/${dir}`, `public/pdfjs/${dir}`, { recursive: true });
}
