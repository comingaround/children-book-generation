// Builds the folder that is uploaded to Vercel: the code (as in git) plus the books chosen for
// the public demo. data/ never goes into git, so the books only reach the site this way.
//
//   node scripts/stage-deploy.mjs <out-dir> <book-id> [<book-id> ...]
//
// Each book's pages are re-saved as JPEG (Vercel answers at most 4.5 MB per response, and some
// imported pages are larger PNGs). The source PDF goes too: the browser builds the PDF from it.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import sharp from 'sharp';

const [out, ...books] = process.argv.slice(2);
if (!out || !books.length) {
  console.error('usage: node scripts/stage-deploy.mjs <out-dir> <book-id> [...]');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
// Tracked and new files, never ignored ones (.env*, data/, docs/).
for (const file of execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
  mkdirSync(dirname(join(out, file)), { recursive: true });
  cpSync(file, join(out, file));
}

for (const id of books) {
  const from = join('data', 'books', id);
  const to = join(out, 'data', 'books', id);
  const book = JSON.parse(readFileSync(join(from, 'book.json'), 'utf8'));
  for (const dir of ['thumbs', 'fonts']) cpSync(join(from, dir), join(to, dir), { recursive: true });
  cpSync(join(from, book.source), join(to, book.source));
  mkdirSync(join(to, 'pages'), { recursive: true });
  for (const page of book.pages) {
    const jpg = page.image.replace(/\.\w+$/, '.jpg');
    await sharp(join(from, page.image)).flatten({ background: '#ffffff' }).jpeg({ quality: 90, mozjpeg: true }).toFile(join(to, jpg));
    page.image = jpg;
  }
  writeFileSync(join(to, 'book.json'), JSON.stringify(book, null, 2));
  console.log(`${id}: ${book.pages.length} pages`);
}
