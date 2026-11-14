// Ads tacked onto the end of an article. The PC's AI gives the first words of
// the ad; the reader hides from there to the end. Nothing stored is cut, and a
// match that would hide more than half the article is ignored as a bad guess.

const MAX_SHARE = 0.5;

/** Lower-case, plain quotes, single spaces; with where each kept character came from. */
function flatten(s: string): { flat: string; at: number[] } {
  let flat = '';
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i]!;
    if (/\s/.test(ch)) {
      if (space || flat.length === 0) continue;
      space = true;
      flat += ' ';
      at.push(i);
      continue;
    }
    space = false;
    if (ch === '‘' || ch === '’') ch = "'";
    else if (ch === '“' || ch === '”') ch = '"';
    flat += ch.toLowerCase();
    at.push(i);
  }
  return { flat, at };
}

/** What to look for: the AI's words, then just their first five (models sometimes run on past the ad's opening). */
function needles(tail: string): string[] {
  const words = flatten(tail).flat.trim().split(' ');
  return [words.join(' '), words.slice(0, 5).join(' ')].filter((n, i, all) => n.length >= 12 && all.indexOf(n) === i);
}

/** Where in this text the ad at the end starts, or null when it can't be found (or would hide too much). */
export function tailStart(text: string, tail: string): number | null {
  const { flat, at } = flatten(text);
  for (const n of needles(tail)) {
    const i = flat.lastIndexOf(n);
    if (i < 0) continue;
    const start = at[i]!;
    return text.length - start <= text.length * MAX_SHARE ? start : null;
  }
  return null;
}

const BLOCK = /^(p|div|td|th|tr|tbody|table|li|ul|ol|h[1-6]|section|article|blockquote|center|header|footer|aside|figure)$/i;

/**
 * Marks the ad at the end of an article (and everything after it) with
 * data-adtail, so the stylesheet can hide it. Returns whether it was found.
 */
export function markAdTail(root: DocumentFragment, tail: string): boolean {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; from: number }[] = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, from: text.length });
    text += `${n.textContent ?? ''} `;
  }
  const start = tailStart(text, tail);
  if (start === null) return false;
  let hit = nodes[0]!;
  for (const n of nodes) {
    if (n.from > start) break;
    hit = n;
  }
  // The block the ad starts in; then it and everything after it, at every level up.
  let block: Node = hit.node;
  for (let up = hit.node.parentElement; up; up = up.parentElement) {
    if (BLOCK.test(up.tagName)) {
      block = up;
      break;
    }
  }
  const total = text.trim().length;
  const marked: Element[] = [];
  let hidden = 0;
  const mark = (n: Node): Node => {
    if (n.nodeType === Node.TEXT_NODE) {
      if (!(n.textContent ?? '').trim()) return n;
      const span = root.ownerDocument!.createElement('span');
      n.parentNode!.replaceChild(span, n);
      span.appendChild(n);
      n = span;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return n;
    hidden += ((n as Element).textContent ?? '').trim().length;
    marked.push(n as Element);
    return n;
  };
  for (let n: Node | null = mark(block); n && n !== root; n = n.parentNode) {
    for (let s = n.nextSibling; s; ) {
      const next = s.nextSibling;
      mark(s);
      s = next;
    }
  }
  if (hidden === 0 || hidden > total * MAX_SHARE) return false;
  for (const el of marked) el.setAttribute('data-adtail', '');
  return true;
}
