// Turns a PDF into a readable article: the text page by page, grouped into
// paragraphs and headings by where the lines sit and how big their letters are,
// with the PDF's pictures, and its charts and tables drawn as pictures, placed
// where they sit on the page. Runs on the PC because reading a PDF takes far
// more time than a free Cloudflare Worker gets.

import { PDF_MAX_PAGES, articleText, countWords, type Article, type ArticleImage } from '@newsletterapp/shared';
import { deflateSync } from 'node:zlib';
import { getDocumentProxy, getResolvedPDFJS, renderPageAsImage } from 'unpdf';
import { loadCanvas, type CanvasModule } from './canvas';
import { log } from './log';

/** Pictures smaller than this (either side, in pixels) are icons, bullets or logos: left out. */
const IMAGE_MIN_PX = 120;
/** Pictures wider than this are scaled down to it. */
const IMAGE_MAX_PX = 1600;
/** At most this many pictures (stored ones plus drawn charts and tables), and this many bytes of them, per PDF. */
const IMAGES_MAX = 40;
const IMAGES_MAX_BYTES = 20_000_000;
/** Charts and tables are drawn at this many pixels per PDF point (2 = sharp on a phone). */
const DRAW_SCALE = 2;

interface Line {
  text: string;
  /** Height of the letters, in PDF points. */
  size: number;
  /** Distance from the bottom of the page. */
  y: number;
  x0: number;
  x1: number;
  /** Runs of text with wide gaps between them (cells of a table, or two columns side by side). */
  cells: { x0: number; x1: number; text: string }[];
}

interface TextBit {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** A box on the page in PDF points (y up from the bottom). */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What goes into the article from one page, in reading order. */
type Block = { kind: 'line'; line: Line } | { kind: 'picture'; top: number; png: Buffer; width: number; height: number; drawn: boolean };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- Text lines ----------

/**
 * The lines of one page, top to bottom, each split into its runs of text. Bits of
 * text are grouped by height on the page rather than by the PDF's own order,
 * which often lists a two-column page line by line across both columns.
 */
export function pageLines(bits: TextBit[]): Line[] {
  const items = bits
    .filter((b) => b.str.trim())
    .map((b) => ({
      str: b.str,
      x: b.transform[4] ?? 0,
      y: b.transform[5] ?? 0,
      w: Math.max(0, b.width || 0),
      size: Math.abs(b.height || b.transform[3] || 0) || 1,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  // Rows: bits whose baselines are within half a letter of each other.
  const rows: (typeof items)[] = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.y - it.y) <= Math.max(2, Math.min(row[0]!.size, it.size) * 0.5)) row.push(it);
    else rows.push([it]);
  }
  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const size = Math.max(...row.map((r) => r.size));
    const cells: Line['cells'] = [];
    for (const it of row) {
      const last = cells[cells.length - 1];
      // A gap of more than about two letters' width starts a new run (a table cell, or the next column).
      if (!last || it.x - last.x1 > Math.max(it.size * 1.5, 8)) cells.push({ x0: it.x, x1: it.x + it.w, text: it.str });
      else {
        last.text += (it.x - last.x1 > it.size * 0.15 && !/\s$/.test(last.text) && !/^\s/.test(it.str) ? ' ' : '') + it.str;
        last.x1 = Math.max(last.x1, it.x + it.w);
      }
    }
    for (const c of cells) c.text = c.text.replace(/\s+/g, ' ').trim();
    lines.push({
      text: cells.map((c) => c.text).join(' '),
      size,
      y: row[0]!.y,
      x0: cells[0]!.x0,
      x1: Math.max(...cells.map((c) => c.x1)),
      cells,
    });
  }
  return lines;
}

/**
 * Two-column pages (most studies): where the gutter between the columns is,
 * or null for one column. Found as a clear vertical strip near the middle of
 * the page that almost no text crosses, with plenty of text on both sides.
 */
export function columnSplit(lines: Line[], page: Box): number | null {
  const cells = lines.flatMap((l) => l.cells.filter((c) => c.text.length > 3));
  if (cells.length < 10) return null;
  const width = page.x1 - page.x0;
  const mid = page.x0 + width / 2;
  let best: { x: number; crossing: number } | null = null;
  for (let x = mid - width * 0.15; x <= mid + width * 0.15; x += 2) {
    const crossing = cells.filter((c) => c.x0 < x - 1 && c.x1 > x + 1).length;
    const left = cells.filter((c) => c.x1 <= x + 1).length;
    const right = cells.filter((c) => c.x0 >= x - 1).length;
    if (left < cells.length * 0.25 || right < cells.length * 0.25) continue;
    if (!best || crossing < best.crossing || (crossing === best.crossing && Math.abs(x - mid) < Math.abs(best.x - mid))) best = { x, crossing };
  }
  // A full-width title or caption may cross the gutter; running text may not.
  if (!best || best.crossing > cells.length * 0.08) return null;
  // Both sides must hold running text (lines filling most of their column), not just a table's cells.
  const at = best.x;
  const left = cells.filter((c) => c.x1 <= at + 1);
  const right = cells.filter((c) => c.x0 >= at - 1);
  const leftStart = Math.min(...left.map((c) => c.x0));
  const rightEnd = Math.max(...right.map((c) => c.x1));
  const fullLeft = left.filter((c) => c.x1 - c.x0 >= (at - leftStart) * 0.6).length;
  const fullRight = right.filter((c) => c.x1 - c.x0 >= (rightEnd - at) * 0.6).length;
  return fullLeft >= 5 && fullRight >= 5 ? at : null;
}

/** Splits a line at the gutter into its left- and right-column parts. */
function splitLine(l: Line, at: number): Line[] {
  const left = l.cells.filter((c) => c.x1 <= at + 2);
  const right = l.cells.filter((c) => c.x0 >= at - 2);
  if (!left.length || !right.length || left.length + right.length !== l.cells.length) return [l];
  const make = (cells: Line['cells']): Line => ({
    ...l,
    cells,
    x0: cells[0]!.x0,
    x1: cells[cells.length - 1]!.x1,
    text: cells.map((c) => c.text.replace(/\s+/g, ' ').trim()).join(' '),
  });
  return [make(left), make(right)];
}

// ---------- Charts and tables ----------

const overlaps = (a: Box, b: Box, pad = 0) => a.x0 - pad < b.x1 && b.x0 - pad < a.x1 && a.y0 - pad < b.y1 && b.y0 - pad < a.y1;
const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const lineBox = (l: Line): Box => ({ x0: l.x0, y0: l.y - l.size * 0.3, x1: l.x1, y1: l.y + l.size });

/** Joins boxes that touch (within pad points) into bigger ones, counting how many went into each. */
function cluster(boxes: Box[], pad: number): (Box & { n: number })[] {
  let out: (Box & { n: number })[] = boxes.map((b) => ({ ...b, n: (b as Box & { n?: number }).n ?? 1 }));
  for (let changed = true; changed; ) {
    changed = false;
    const next: (Box & { n: number })[] = [];
    for (const b of out) {
      const hit = next.find((o) => overlaps(o, b, pad));
      if (hit) {
        Object.assign(hit, union(hit, b), { n: hit.n + b.n });
        changed = true;
      } else next.push({ ...b });
    }
    out = next;
  }
  return out;
}

/**
 * Areas of the page drawn with lines and shapes (charts, diagrams, ruled
 * tables), from the page's drawing commands. Page borders and backgrounds are left out.
 */
function drawnAreas(list: { fnArray: number[]; argsArray: unknown[][] }, ops: Record<string, number>, page: Box): Box[] {
  const pageArea = (page.x1 - page.x0) * (page.y1 - page.y0);
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const boxes: Box[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i] ?? [];
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? ctm;
    else if (fn === ops.transform) ctm = multiply(ctm, args as Matrix);
    else if (fn === ops.constructPath) {
      // [how it is painted, the path, its bounds]; a path that is only a clip draws nothing.
      if (args[0] === ops.endPath) continue;
      const mm = args[2] as ArrayLike<number> | null | undefined;
      if (!mm || mm.length < 4 || !Number.isFinite(mm[0]!)) continue;
      const pts = [
        apply(ctm, mm[0]!, mm[1]!),
        apply(ctm, mm[2]!, mm[3]!),
        apply(ctm, mm[0]!, mm[3]!),
        apply(ctm, mm[2]!, mm[1]!),
      ];
      const b: Box = {
        x0: Math.min(...pts.map((p) => p[0])),
        y0: Math.min(...pts.map((p) => p[1])),
        x1: Math.max(...pts.map((p) => p[0])),
        y1: Math.max(...pts.map((p) => p[1])),
      };
      if ((b.x1 - b.x0) * (b.y1 - b.y0) > pageArea * 0.6) continue;
      boxes.push(b);
    }
  }
  // Something worth drawing has several shapes and some size; a lone rule or box is just decoration.
  return cluster(boxes, 6)
    .filter((b) => b.n >= 6 && b.x1 - b.x0 >= 60 && b.y1 - b.y0 >= 40)
    .map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));
}

/** Tables with no lines drawn: three or more lines in a row, each split into three or more runs. */
function textTables(lines: Line[]): Box[] {
  const out: Box[] = [];
  let run: Line[] = [];
  const end = () => {
    if (run.length >= 3) out.push(run.map(lineBox).reduce(union));
    run = [];
  };
  for (const l of lines) {
    if (l.cells.length >= 3) run.push(l);
    else end();
  }
  end();
  return out;
}

/** Cuts the areas out of a drawing of the whole page, as PNGs. */
async function drawAreas(canvas: CanvasModule, bytes: Uint8Array, pageNumber: number, view: Box, areas: Box[]): Promise<Buffer[]> {
  const png = await renderPageAsImage(bytes.slice(), pageNumber, { canvasImport: async () => canvas as never, scale: DRAW_SCALE });
  const img = await canvas.loadImage(Buffer.from(png));
  return areas.map((a) => {
    // A little room around the sides; less above and below, where the text around it sits.
    const pad = 6;
    const padY = 2;
    const sx = Math.max(0, Math.floor((a.x0 - pad - view.x0) * DRAW_SCALE));
    const sy = Math.max(0, Math.floor((view.y1 - a.y1 - padY) * DRAW_SCALE));
    const sw = Math.min(img.width - sx, Math.ceil((a.x1 - a.x0 + pad * 2) * DRAW_SCALE));
    const sh = Math.min(img.height - sy, Math.ceil((a.y1 - a.y0 + padY * 2) * DRAW_SCALE));
    const c = canvas.createCanvas(Math.max(1, sw), Math.max(1, sh));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return c.toBuffer('image/png');
  });
}

// ---------- Stored pictures ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const b of parts) for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([name, data]));
  return Buffer.concat([len, name, data, crc]);
}

/** Raw pixels (grey, RGB or RGBA) as a PNG file, scaled down when very wide. */
export function encodePng(data: Uint8ClampedArray | Uint8Array, width: number, height: number, channels: 1 | 3 | 4): Buffer {
  const scale = width > IMAGE_MAX_PX ? IMAGE_MAX_PX / width : 1;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const row = w * channels;
  const raw = Buffer.alloc((row + 1) * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    raw[y * (row + 1)] = 0; // no filter
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const from = (sy * width + sx) * channels;
      const to = y * (row + 1) + 1 + x * channels;
      for (let k = 0; k < channels; k++) raw[to + k] = data[from + k]!;
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8; // bits per channel
  head[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  n[0] * m[0] + n[1] * m[2],
  n[0] * m[1] + n[1] * m[3],
  n[2] * m[0] + n[3] * m[2],
  n[2] * m[1] + n[3] * m[3],
  n[4] * m[0] + n[5] * m[2] + m[4],
  n[4] * m[1] + n[5] * m[3] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

interface PdfPage {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: { get(key: string, cb: (v: unknown) => void): void };
  commonObjs: { get(key: string, cb: (v: unknown) => void): void };
}

interface StoredPicture {
  box: Box;
  png: Buffer;
  width: number;
  height: number;
}

/** The pictures stored in one page (photos, scanned figures), with where each sits. */
async function storedPictures(page: PdfPage, list: { fnArray: number[]; argsArray: unknown[][] }, ops: Record<string, number>): Promise<StoredPicture[]> {
  const out: StoredPicture[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const seen = new Set<string>();
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i] ?? [];
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? ctm;
    else if (fn === ops.transform) ctm = multiply(ctm, args as Matrix);
    else if (fn === ops.paintImageXObject) {
      const key = String(args[0]);
      if (seen.has(key)) continue;
      seen.add(key);
      const objs = key.startsWith('g_') ? page.commonObjs : page.objs;
      const img = await new Promise<{ data?: Uint8ClampedArray; width?: number; height?: number } | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 5000);
        objs.get(key, (v) => {
          clearTimeout(timer);
          resolve(v as never);
        });
      });
      if (!img?.data || !img.width || !img.height) continue;
      if (img.width < IMAGE_MIN_PX || img.height < IMAGE_MIN_PX) continue;
      const channels = img.data.length / (img.width * img.height);
      if (channels !== 1 && channels !== 3 && channels !== 4) continue;
      // The picture fills the unit square under the current matrix.
      const pts = [apply(ctm, 0, 0), apply(ctm, 1, 1)];
      const box: Box = {
        x0: Math.min(pts[0]![0], pts[1]![0]),
        y0: Math.min(pts[0]![1], pts[1]![1]),
        x1: Math.max(pts[0]![0], pts[1]![0]),
        y1: Math.max(pts[0]![1], pts[1]![1]),
      };
      out.push({ box, png: encodePng(img.data, img.width, img.height, channels), width: img.width, height: img.height });
    }
  }
  return out;
}

// ---------- The article ----------

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** "Microsoft Word - draft3.doc" and the like aren't real titles. */
function usableTitle(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const s = t.replace(/\s+/g, ' ').trim();
  if (s.length < 3 || s.length > 300) return null;
  if (/^(untitled|microsoft word|document\d*|title)\b/i.test(s) || /\.(docx?|pdf|indd|tex)$/i.test(s)) return null;
  return s;
}

/** Joins a line onto a paragraph, mending words split with a hyphen at the line's end. */
function joinLine(para: string, line: string): string {
  if (!para) return line;
  if (/[a-z]-$/.test(para) && /^[a-z]/.test(line)) return para.slice(0, -1) + line;
  return `${para} ${line}`;
}

/** Puts a page's lines and pictures in reading order: by column, top to bottom. */
function readingOrder(lines: Line[], pictures: { box: Box; block: Block }[], split: number | null): Block[] {
  const columnOf = (x0: number, x1: number) => (split === null ? 0 : x1 <= split + 2 ? 0 : x0 >= split - 2 ? 1 : -1);
  type Placed = { col: number; top: number; block: Block };
  const placed: Placed[] = [];
  for (const l of split === null ? lines : lines.flatMap((x) => splitLine(x, split))) {
    placed.push({ col: columnOf(l.x0, l.x1), top: l.y + l.size, block: { kind: 'line', line: l } });
  }
  for (const p of pictures) placed.push({ col: columnOf(p.box.x0, p.box.x1), top: p.box.y1, block: p.block });
  // Full-width parts (-1: a title, a wide figure) come before the columns below them, so
  // read in bands: each full-width part closes the band of column text above it.
  const wide = placed.filter((p) => p.col === -1).sort((a, b) => b.top - a.top);
  const cols = placed.filter((p) => p.col !== -1);
  const out: Block[] = [];
  let ceiling = Infinity;
  const band = (floor: number) => {
    const inBand = cols.filter((p) => p.top <= ceiling && p.top > floor);
    for (const c of [0, 1]) out.push(...inBand.filter((p) => p.col === c).sort((a, b) => b.top - a.top).map((p) => p.block));
  };
  for (const w of wide) {
    band(w.top);
    out.push(w.block);
    ceiling = w.top;
  }
  band(-Infinity);
  return out;
}

/** The PDF's text as an article, with its pictures. Throws when the file can't be read at all. */
export async function pdfArticle(input: Uint8Array): Promise<Article & { pages: number; drawn: number }> {
  // pdf.js may take over the bytes it is given; drawing a page needs its own copy.
  const bytes = input.slice();
  const pdf = await getDocumentProxy(input);
  try {
    const meta = await pdf.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const pageCount = pdf.numPages;
    const upTo = Math.min(pageCount, PDF_MAX_PAGES);
    const { OPS } = await getResolvedPDFJS();
    const ops = OPS as unknown as Record<string, number>;

    let canvas: CanvasModule | null | undefined;
    let canvasNote = false;
    let pictureCount = 0;
    let pictureBytes = 0;
    let drawn = 0;
    const room = (n: number) => pictureCount < IMAGES_MAX && pictureBytes + n <= IMAGES_MAX_BYTES;

    const pages: { lines: Line[]; blocks: Block[] }[] = [];
    for (let n = 1; n <= upTo; n++) {
      const page = await pdf.getPage(n);
      const [x0, y0, x1, y1] = page.view as [number, number, number, number];
      const view: Box = { x0, y0, x1, y1 };
      const content = await page.getTextContent();
      let lines = pageLines(content.items.filter((i) => 'str' in i) as unknown as TextBit[]);
      const list = await page.getOperatorList().catch(() => ({ fnArray: [] as number[], argsArray: [] as unknown[][] }));
      const pictures: { box: Box; block: Block }[] = [];

      // Charts, diagrams and tables: drawn as pictures, and the words inside them left out of the text.
      const split = columnSplit(lines, view);
      const areas = cluster([...drawnAreas(list, ops, view), ...textTables(split === null ? lines : lines.flatMap((l) => splitLine(l, split)))], 4).map(
        ({ x0: a, y0: b, x1: c, y1: d }) => ({ x0: a, y0: b, x1: c, y1: d }),
      );
      // A chart's labels (axis names, the legend) sit just outside its lines: take them in too.
      // Labels are short or set smaller than the running text, which stays out.
      const pageBody = median(lines.map((l) => l.size)) || 10;
      for (const a of areas) {
        for (const l of lines) {
          const lb = lineBox(l);
          if ((l.text.length <= 25 || l.size < pageBody * 0.92) && !overlaps(a, lb) && overlaps(a, lb, Math.max(14, l.size * 1.6)) && lb.x0 >= a.x0 - 40 && lb.x1 <= a.x1 + 40) {
            Object.assign(a, union(a, lb));
          }
        }
      }
      const stored = await storedPictures(page as unknown as PdfPage, list, ops).catch(() => [] as StoredPicture[]);
      // A stored picture inside a drawn area is already part of the drawing.
      const loose = stored.filter((p) => !areas.some((a) => overlaps(a, p.box, -2)));
      if (areas.length && room(0)) {
        if (canvas === undefined) canvas = await loadCanvas().catch((err: unknown) => {
          log(`PDF charts and tables can't be drawn: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });
        if (canvas) {
          const pngs = await drawAreas(canvas, bytes, n, view, areas).catch((err: unknown) => {
            log(`PDF page ${n}: drawing failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          });
          if (pngs) {
            areas.forEach((a, i) => {
              const png = pngs[i]!;
              if (!room(png.length)) return;
              pictureCount++;
              pictureBytes += png.length;
              drawn++;
              const w = Math.round((a.x1 - a.x0 + 12) * DRAW_SCALE);
              const h = Math.round((a.y1 - a.y0 + 4) * DRAW_SCALE);
              pictures.push({ box: a, block: { kind: 'picture', top: a.y1, png, width: w, height: h, drawn: true } });
            });
            // Words drawn into the picture (axis labels, table cells) would only jumble the text.
            const inside = (l: Line) => areas.some((a) => overlaps(a, lineBox(l), -1));
            lines = lines.filter((l) => !inside(l));
          }
        } else {
          canvasNote = true;
        }
      }
      for (const p of loose) {
        if (!room(p.png.length)) break;
        pictureCount++;
        pictureBytes += p.png.length;
        pictures.push({ box: p.box, block: { kind: 'picture', top: p.box.y1, png: p.png, width: p.width, height: p.height, drawn: false } });
      }
      pages.push({ lines, blocks: readingOrder(lines, pictures, columnSplit(lines, view) ?? split) });
      page.cleanup();
    }

    const all = pages.flatMap((p) => p.lines);
    const body = median(all.map((l) => l.size)) || 10;
    // Running heads and footers: the same short line at the top or bottom of most pages, or a bare page number.
    const edges = (p: Line[]) => new Set([...p.slice(0, 2), ...p.slice(-2)]);
    const mask = (t: string) => t.replace(/\d+/g, '#');
    const seen = new Map<string, number>();
    for (const p of pages) {
      const texts = new Set([...edges(p.lines)].flatMap((l) => [l.text, ...l.cells.map((c) => c.text)]).map(mask));
      for (const t of texts) seen.set(t, (seen.get(t) ?? 0) + 1);
    }
    const repeatedText = (t: string) => pages.length >= 2 && t.length < 90 && (seen.get(mask(t)) ?? 0) >= Math.max(2, Math.ceil(pages.length * 0.6));
    const pageNumber = (t: string) => /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t);

    // The title: the PDF's own, else the biggest short line on the first page.
    let title = usableTitle(info.Title);
    if (!title && pages[0]?.lines.length) {
      const big = pages[0].lines.filter((l) => l.text.length <= 150).sort((a, b) => b.size - a.size)[0];
      if (big && big.size >= body * 1.15) title = big.text;
    }

    const out: string[] = [];
    const images: ArticleImage[] = [];
    const allSteps = median(
      pages.flatMap(({ blocks }) =>
        blocks.flatMap((b, i) => {
          const a = blocks[i - 1];
          return a?.kind === 'line' && b.kind === 'line' && a.line.y > b.line.y ? [a.line.y - b.line.y] : [];
        }),
      ),
    );
    let para = '';
    let prev: Line | null = null;
    // Pictures met in the middle of a paragraph wait for its end, so a sentence isn't cut in two.
    let waiting: string[] = [];
    const ended = (t: string) => /[.!?:;"”’)\]]$/.test(t);
    const flush = () => {
      if (para) out.push(`<p>${esc(para)}</p>`);
      out.push(...waiting);
      para = '';
      prev = null;
      waiting = [];
    };
    for (const { lines, blocks } of pages) {
      // Running heads and footers sit in the top or bottom two rows of the page (lines may have been split at the gutter).
      const ys = [...new Set(lines.map((l) => l.y))].sort((a, b) => b - a);
      const topY = ys[Math.min(1, ys.length - 1)] ?? Infinity;
      const bottomY = ys[Math.max(0, ys.length - 2)] ?? -Infinity;
      const atEdge = (l: Line) => l.y >= topY || l.y <= bottomY;
      // The usual space between lines on this page; a clearly bigger gap starts a new paragraph.
      const steps: number[] = [];
      for (let i = 1; i < blocks.length; i++) {
        const a = blocks[i - 1]!;
        const b = blocks[i]!;
        if (a.kind === 'line' && b.kind === 'line' && a.line.y > b.line.y) steps.push(a.line.y - b.line.y);
      }
      // A page with little running text (a table and a caption) goes by the whole document's spacing.
      const step = steps.length >= 5 ? median(steps) : allSteps || body * 1.2;
      for (const b of blocks) {
        if (b.kind === 'picture') {
          const name = `pdf-image:${images.length}`;
          images.push({ name, type: 'image/png', data: b.png.toString('base64') });
          const tag = `<p><img src="${name}" width="${b.width}" height="${b.height}" alt="${b.drawn ? 'Chart or table from the PDF' : ''}"></p>`;
          // Mid-sentence it waits for the paragraph's end; otherwise it ends the paragraph.
          if (para && !ended(para)) waiting.push(tag);
          else {
            flush();
            out.push(tag);
          }
          continue;
        }
        const l = b.line;
        if (pageNumber(l.text) || (atEdge(l) && repeatedText(l.text))) continue;
        const heading = l.size >= body * 1.25 && l.text.length <= 150;
        if (heading) {
          flush();
          // The title is already the item's headline.
          if (!(title && out.length === 0 && l.text === title)) out.push(`<h3>${esc(l.text)}</h3>`);
          continue;
        }
        const p: Line | null = prev;
        if (p) {
          const gap = p.y - l.y;
          // Moving up the page is the next column: the paragraph runs on unless its sentence had ended.
          if (gap < 0 ? ended(para) : gap > Math.max(step * 1.3, Math.min(p.size, l.size) * 1.1)) flush();
        } else if (para && ended(para)) {
          // First line of a new page after a finished sentence.
          flush();
        }
        para = joinLine(para, l.text);
        prev = l;
      }
      // A sentence running on to the next page carries over; otherwise the paragraph ends with the page.
      if (ended(para)) flush();
      else prev = null;
    }
    flush();
    if (canvasNote) out.push(`<p><em>This PDF has charts or tables the PC couldn't draw; open the PDF to see them.</em></p>`);
    if (pageCount > upTo) out.push(`<p><em>That was the first ${upTo} of ${pageCount} pages; open the PDF for the rest.</em></p>`);
    const html = out.join('\n');
    const text = articleText(html);
    const author = typeof info.Author === 'string' && info.Author.trim() ? info.Author.trim().slice(0, 120) : null;
    return { title, author, publishedAt: null, html, text, wordCount: countWords(text), fileType: 'application/pdf', images, pages: pageCount, drawn };
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}
