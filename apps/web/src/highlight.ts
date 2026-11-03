import type { Highlight, HighlightAnchor } from '@newsletterapp/shared';

// Finding, marking and capturing highlights in the article. A highlight is
// stored as its text plus a little of the text either side (the way web
// annotation tools do it), so it can be found again however the article is
// drawn next time. The article lives in a shadow root (EmailBody) or a plain
// element (text-only items); both are treated the same.

const PAD = 32;
const MARK_CLASS = 'hl';

type Root = ShadowRoot | HTMLElement;

/** Text nodes in reading order, leaving out style sheets. */
function textNodes(root: Root): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('style, script, noscript') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

interface TextIndex {
  text: string;
  nodes: Text[];
  /** Where each node starts in `text`. */
  starts: number[];
}

function indexText(root: Root): TextIndex {
  const nodes = textNodes(root);
  const starts: number[] = [];
  let text = '';
  for (const n of nodes) {
    starts.push(text.length);
    text += n.data;
  }
  return { text, nodes, starts };
}

/** Position of (node, offset) in the joined text, or -1 when the node isn't in the article. */
function positionOf(index: TextIndex, node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    const i = index.nodes.indexOf(node as Text);
    return i < 0 ? -1 : index.starts[i]! + offset;
  }
  // An element boundary: the position of the first text node at or after it.
  const point = document.createRange();
  point.setStart(node, offset);
  point.collapse(true);
  for (let i = 0; i < index.nodes.length; i++) {
    if (point.comparePoint(index.nodes[i]!, 0) >= 0) return index.starts[i]!;
  }
  return index.text.length;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The paragraph-ish block around a node, as plain text. */
function blockText(node: Node, root: Root): string {
  let el: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && el !== (root as unknown as Element)) {
    if (/^(P|LI|TD|BLOCKQUOTE|H[1-6]|DIV|SECTION|ARTICLE|PRE)$/.test(el.tagName) && squash(el.textContent ?? '').length >= 40) break;
    el = el.parentElement;
  }
  const text = squash((el ?? (root as Node)).textContent ?? '');
  return text.slice(0, 1500);
}

/**
 * The user's current selection inside the article, if there is one. Browsers
 * report selections inside a shadow root differently: newer ones support
 * getComposedRanges, Chrome has ShadowRoot.getSelection, and Firefox on a PC
 * puts the shadow nodes straight into the document selection. WebKit (Safari,
 * and every browser on an iPad or iPhone, Firefox included) may instead hand
 * back a range pinned to the shadow host, often collapsed, while the selected
 * text is still there in toString(); for that we find the text ourselves.
 */
export function selectedRange(root: Root, near?: { x: number; y: number } | null): Range | null {
  const sel = document.getSelection();
  if (!sel) return null;
  const inRoot = (r: AbstractRange) => root.contains(r.startContainer) && root.contains(r.endContainer);
  const toRange = (r: AbstractRange) => {
    const range = document.createRange();
    range.setStart(r.startContainer, r.startOffset);
    range.setEnd(r.endContainer, r.endOffset);
    return range;
  };
  if (root instanceof ShadowRoot) {
    const composed = (sel as Selection & { getComposedRanges?: (...a: unknown[]) => StaticRange[] }).getComposedRanges;
    if (composed) {
      for (const args of [[{ shadowRoots: [root] }], [root]]) {
        try {
          const r = composed.apply(sel, args)[0];
          if (r && !r.collapsed && inRoot(r)) return toRange(r);
        } catch {
          // Older signature; try the other one.
        }
      }
    }
    try {
      const own = (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.();
      if (own && own.rangeCount > 0 && !own.isCollapsed) {
        const r = own.getRangeAt(0);
        if (inRoot(r)) return r;
      }
    } catch {
      // Not supported here.
    }
  }
  if (sel.rangeCount > 0 && !sel.isCollapsed) {
    const r = sel.getRangeAt(0);
    if (inRoot(r)) return r;
  }
  // WebKit: the range only points at the shadow host. Use the selected text instead.
  if (!(root instanceof ShadowRoot) || sel.rangeCount === 0) return null;
  const host = root.host;
  const r = sel.getRangeAt(0);
  // Pinned at (or around) the host, not a selection somewhere else on the page.
  if (!r.commonAncestorContainer.contains(host)) return null;
  const text = sel.toString();
  if (squash(text).length < 1) return null;
  return findText(root, text, near ?? null);
}

/** A range over `text` in the article, picking the copy nearest `near` (a point on screen) when it repeats. */
function findText(root: Root, text: string, near: { x: number; y: number } | null): Range | null {
  const index = indexText(root);
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return null;
  const re = new RegExp(words.join('\\s*'), 'g');
  let best: Range | null = null;
  let bestDist = Infinity;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(index.text)) && count++ < 200) {
    const range = rangeAt(index, m.index, m.index + m[0].length);
    if (!range) continue;
    if (!near) return range;
    const rect = range.getBoundingClientRect();
    const dx = Math.max(rect.left - near.x, 0, near.x - rect.right);
    const dy = Math.max(rect.top - near.y, 0, near.y - rect.bottom);
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = range;
    }
  }
  return best;
}

function rangeAt(index: TextIndex, from: number, to: number): Range | null {
  let start: [Text, number] | null = null;
  let end: [Text, number] | null = null;
  for (let i = 0; i < index.nodes.length; i++) {
    const s = index.starts[i]!;
    const n = index.nodes[i]!;
    const e = s + n.data.length;
    if (!start && from >= s && from < e) start = [n, from - s];
    if (to > s && to <= e) {
      end = [n, to - s];
      break;
    }
  }
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start[0], start[1]);
  range.setEnd(end[0], end[1]);
  return range;
}

/**
 * How well a stored highlight fits an article root: 3 with both sides of
 * context, 2 with one side, 1 for the bare quote, 0 not there. Used to tell
 * highlights in the AI summary from ones in the article.
 */
export function matchScore(root: Root, h: HighlightAnchor): number {
  const text = indexText(root).text;
  if (text.includes(h.prefix + h.quote + h.suffix)) return 3;
  if ((h.prefix && text.includes(h.prefix + h.quote)) || (h.suffix && text.includes(h.quote + h.suffix))) return 2;
  return locate(text, h) ? 1 : 0;
}

const MAX_QUOTE = 1500;

/** Turns a selection into what gets stored: the quote, a little text either side, and the paragraph. */
export function anchorFor(root: Root, range: Range): HighlightAnchor | null {
  const index = indexText(root);
  let start = positionOf(index, range.startContainer, range.startOffset);
  let end = positionOf(index, range.endContainer, range.endOffset);
  if (start < 0 || end < 0 || end <= start) return null;
  // Trim spaces at the ends so a double-tapped word doesn't carry its trailing space.
  while (start < end && /\s/.test(index.text[start]!)) start++;
  while (end > start && /\s/.test(index.text[end - 1]!)) end--;
  if (end - start < 1) return null;
  end = Math.min(end, start + MAX_QUOTE);
  return {
    quote: index.text.slice(start, end),
    prefix: index.text.slice(Math.max(0, start - PAD), start),
    suffix: index.text.slice(end, end + PAD),
    textOffset: start,
    context: blockText(range.startContainer, root),
  };
}

/** Where a stored highlight sits in the article now: exact with context, then the copy nearest where it was. */
function locate(text: string, h: HighlightAnchor): [number, number] | null {
  const full = h.prefix + h.quote + h.suffix;
  const at = text.indexOf(full);
  if (at >= 0 && text.indexOf(full, at + 1) < 0) return [at + h.prefix.length, at + h.prefix.length + h.quote.length];
  let best = -1;
  for (let i = text.indexOf(h.quote); i >= 0; i = text.indexOf(h.quote, i + 1)) {
    if (best < 0 || Math.abs(i - h.textOffset) < Math.abs(best - h.textOffset)) best = i;
  }
  if (best >= 0) return [best, best + h.quote.length];
  // Spacing can change between renders; try again ignoring runs of whitespace.
  const words = h.quote
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return null;
  const re = new RegExp(words.join('\\s+'), 'g');
  let m: RegExpExecArray | null;
  let found: [number, number] | null = null;
  while ((m = re.exec(text))) {
    if (!found || Math.abs(m.index - h.textOffset) < Math.abs(found[0] - h.textOffset)) found = [m.index, m.index + m[0].length];
  }
  return found;
}

/** Removes every highlight mark, putting the text back as it was. */
export function clearMarks(root: Root) {
  for (const mark of Array.from(root.querySelectorAll(`mark.${MARK_CLASS}`))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

/**
 * Marks each highlight in the article. Returns the ids that couldn't be found
 * (the article changed), so their notes can say so.
 */
export function applyMarks(root: Root, highlights: Highlight[], activeId: string | null = null): string[] {
  clearMarks(root);
  const missing: string[] = [];
  for (const h of highlights) {
    const index = indexText(root);
    const span = locate(index.text, h);
    if (!span) {
      missing.push(h.id);
      continue;
    }
    const [from, to] = span;
    // Wrap the part of each text node that falls inside [from, to), last first so offsets stay put.
    const pieces: { node: Text; a: number; b: number }[] = [];
    for (let i = 0; i < index.nodes.length; i++) {
      const s = index.starts[i]!;
      const n = index.nodes[i]!;
      const e = s + n.data.length;
      if (e <= from || s >= to) continue;
      pieces.push({ node: n, a: Math.max(from, s) - s, b: Math.min(to, e) - s });
    }
    for (const p of pieces.reverse()) {
      if (p.b <= p.a || !p.node.data.slice(p.a, p.b).trim()) continue;
      const tail = p.node.splitText(p.a);
      tail.splitText(p.b - p.a);
      const mark = document.createElement('mark');
      mark.className = MARK_CLASS + (h.id === activeId ? ' hl--active' : '');
      mark.dataset.hl = h.id;
      tail.parentNode!.insertBefore(mark, tail);
      mark.appendChild(tail);
    }
  }
  return missing;
}

/** Scrolls the first mark of a highlight into view and flashes it. */
export function revealMark(root: Root, id: string) {
  const mark = root.querySelector<HTMLElement>(`mark.${MARK_CLASS}[data-hl="${CSS.escape(id)}"]`);
  if (!mark) return false;
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const m of Array.from(root.querySelectorAll<HTMLElement>(`mark.${MARK_CLASS}[data-hl="${CSS.escape(id)}"]`))) {
    m.classList.remove('hl--flash');
    void m.offsetWidth;
    m.classList.add('hl--flash');
  }
  return true;
}

/** Styles for marks inside the shadow root (the app's stylesheet doesn't reach in there). */
export const MARK_CSS = `
  mark.hl { background: rgba(250, 204, 21, 0.45); color: inherit; border-radius: 2px; cursor: pointer; padding: 0; }
  mark.hl--active { background: rgba(250, 204, 21, 0.75); }
  @keyframes hlflash { 0%, 100% { background: rgba(250, 204, 21, 0.45); } 40% { background: rgba(245, 158, 11, 0.9); } }
  mark.hl--flash { animation: hlflash 1.2s ease 2; }
  @media (prefers-color-scheme: dark) {
    mark.hl { background: rgba(234, 179, 8, 0.35); }
    mark.hl--active { background: rgba(234, 179, 8, 0.6); }
  }
`;
