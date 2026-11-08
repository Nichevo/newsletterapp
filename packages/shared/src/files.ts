// Links that are files, not web pages: a PDF, a picture, a Word file, a zip.
// Reading one of those as if it were a page saves its raw bytes as junk text,
// so both the Worker (Add > Just one page) and the PC helper (Fetch full page)
// check what came back before reading it.

/** What a link turned out to be. */
export type FileKind = 'page' | 'text' | 'pdf' | 'image' | 'other';

/** Most a page added on its own keeps as its own copy of a PDF or picture (bytes). */
export const KEEP_FILE_MAX_BYTES = 8_000_000;

/** Pages of a PDF turned into text; the rest stay in the PDF itself. */
export const PDF_MAX_PAGES = 60;

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** Recognises a file by its first bytes, whatever the server says it is. */
function sniff(b: Uint8Array): FileKind | null {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return 'image'; // PNG
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image'; // JPEG
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return 'image'; // GIF8
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'image'; // RIFF....WEBP
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return 'other'; // zip: .docx, .xlsx, .epub, .zip
  if (startsWith(b, [0x1f, 0x8b])) return 'other'; // gzip
  if (startsWith(b, [0x49, 0x44, 0x33]) || startsWith(b, [0x66, 0x74, 0x79, 0x70], 4) || startsWith(b, [0x4f, 0x67, 0x67, 0x53])) return 'other'; // mp3, mp4, ogg
  // Text has no zero bytes; binary files nearly always do near the start.
  for (let i = 0; i < Math.min(b.length, 1024); i++) if (b[i] === 0) return 'other';
  return null;
}

/** The kind of file from the server's Content-Type alone (null when it doesn't say). */
export function kindFromType(contentType: string | null | undefined): FileKind | null {
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!t) return null;
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'page';
  if (t === 'application/pdf' || t === 'application/x-pdf') return 'pdf';
  if (t === 'image/svg+xml') return 'other';
  if (t.startsWith('image/')) return 'image';
  if (t === 'text/plain' || t === 'text/markdown' || t === 'text/x-markdown') return 'text';
  // Servers often call any file "octet-stream": look at the bytes instead.
  if (t === 'application/octet-stream' || t === 'binary/octet-stream') return null;
  return 'other';
}

/**
 * What a fetched link is: the bytes win over the server's Content-Type (many
 * servers label PDFs as octet-stream, and some label everything text/html).
 */
export function fileKind(contentType: string | null | undefined, firstBytes: Uint8Array): FileKind {
  const sniffed = firstBytes.length ? sniff(firstBytes) : null;
  if (sniffed) return sniffed;
  const typed = kindFromType(contentType);
  if (typed) return typed;
  // Unlabelled text: a page if it looks like markup, else plain text.
  const head = new TextDecoder().decode(firstBytes.subarray(0, 2048)).toLowerCase();
  return /<(!doctype|html|head|body|p|div|article)\b/.test(head) ? 'page' : 'text';
}

/** The name to show for a link with no title: the file name from its address, or the address. */
export function fileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return last || u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A readable title from a file name: "Turtledove_RoadNotTaken.pdf" -> "Turtledove RoadNotTaken". */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base || name;
}

/** Plain words for a file type, for notes like "This link is a Word file". */
export function fileTypeLabel(contentType: string | null | undefined, url = ''): string {
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const ext = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase() ?? '';
  if (t.includes('pdf') || ext === 'pdf') return 'PDF';
  if (t.includes('wordprocessingml') || t.includes('msword') || ext === 'docx' || ext === 'doc') return 'Word file';
  if (t.includes('spreadsheetml') || t.includes('ms-excel') || ext === 'xlsx' || ext === 'xls' || ext === 'csv') return 'spreadsheet';
  if (t.includes('presentationml') || t.includes('ms-powerpoint') || ext === 'pptx' || ext === 'ppt') return 'slide deck';
  if (t.includes('epub') || ext === 'epub') return 'e-book';
  if (t.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'ogg', 'flac'].includes(ext)) return 'sound file';
  if (t.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video';
  if (t.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return 'picture';
  if (t.includes('zip') || ext === 'zip') return 'zip file';
  if (t.startsWith('text/') || ext === 'txt' || ext === 'md') return 'text file';
  if (t.includes('json') || ext === 'json') return 'JSON file';
  if (t.includes('xml') || ext === 'xml') return 'XML file';
  return 'file';
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain text file as reader HTML: blank lines start paragraphs, single line breaks are kept. */
export function textFileHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** The reader's note for a file the app can't show as an article, with a link to open it. */
export function fileNoteHtml(label: string, href: string): string {
  const a = /^[aeiou]/i.test(label) ? 'an' : 'a';
  return `<p><em>This link is ${a} ${esc(label)}, not a web page, so there's no article to show.</em></p><p><a href="${esc(href)}">Open the ${esc(label)}</a></p>`;
}
