import { KEY_COLOURS, KEY_KINDS, type KeyKind, type KeyMark } from '@newsletterapp/shared';
import { indexText } from './highlight';

// Drawing key sentences in the article. The PC found them in its own plain-text
// copy, so spacing and invisible characters can differ from what the browser
// draws; matching ignores both. Marks are <span class="ks ks--main"> wrapped
// round the sentence (several spans when it crosses links or bold text), kept
// apart from highlight <mark>s so the two never clear each other.

type Root = ShadowRoot | HTMLElement;

const CLASS = 'ks';
/** Whitespace and characters that draw as nothing (soft hyphens, zero-width spaces). */
const SKIP = /[\s­͏​-‏⁠﻿]/;

/** The article's text with whitespace and invisible characters taken out, and where each character came from. */
function compactText(text: string): { compact: string; map: number[] } {
  let compact = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (SKIP.test(ch)) continue;
    compact += ch;
    map.push(i);
  }
  return { compact, map };
}

const squeeze = (s: string) => compactText(s).compact;

/** Where a key sentence is in the joined text, or null when this copy of the article doesn't have it. */
export function findSentence(text: string, packed: { compact: string; map: number[] }, m: KeyMark): [number, number] | null {
  const quote = squeeze(m.quote);
  if (!quote) return null;
  const before = squeeze(m.prefix).slice(-12);
  const after = squeeze(m.suffix).slice(0, 12);
  let best = -1;
  let bestScore = -Infinity;
  let tries = 0;
  for (let at = packed.compact.indexOf(quote); at >= 0 && tries++ < 50; at = packed.compact.indexOf(quote, at + 1)) {
    // Text either side that matches counts most; then being near where the PC saw it.
    let score = 0;
    if (before && packed.compact.slice(Math.max(0, at - before.length), at) === before) score += 2;
    if (after && packed.compact.slice(at + quote.length, at + quote.length + after.length) === after) score += 2;
    score -= Math.abs(packed.map[at]! - m.textOffset) / Math.max(text.length, 1);
    if (score > bestScore) {
      bestScore = score;
      best = at;
    }
  }
  if (best < 0) return null;
  return [packed.map[best]!, packed.map[best + quote.length - 1]! + 1];
}

/** Takes every key-sentence span out, putting the text back as it was. */
export function clearKeyMarks(root: Root) {
  for (const span of Array.from(root.querySelectorAll(`span.${CLASS}`))) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }
}

/**
 * Wraps each key sentence in the article. `marks` keeps its order from the
 * server (data-ks is the position there); removed ones are skipped. Returns
 * how many were found.
 */
export function applyKeyMarks(root: Root, marks: KeyMark[]): number {
  clearKeyMarks(root);
  const first = indexText(root);
  const packed = compactText(first.text);
  // Positions in the joined text don't move when text nodes are split, so find them all first.
  const spans: { i: number; kind: KeyKind; from: number; to: number }[] = [];
  marks.forEach((m, i) => {
    if (m.fix === 'removed') return;
    const at = findSentence(first.text, packed, m);
    if (at) spans.push({ i, kind: m.kind, from: at[0], to: at[1] });
  });
  for (const s of spans) {
    const index = indexText(root);
    const pieces: { node: Text; a: number; b: number }[] = [];
    for (let n = 0; n < index.nodes.length; n++) {
      const start = index.starts[n]!;
      const node = index.nodes[n]!;
      const end = start + node.data.length;
      if (end <= s.from || start >= s.to) continue;
      pieces.push({ node, a: Math.max(s.from, start) - start, b: Math.min(s.to, end) - start });
    }
    for (const p of pieces.reverse()) {
      if (p.b <= p.a || !p.node.data.slice(p.a, p.b).trim()) continue;
      const tail = p.node.splitText(p.a);
      tail.splitText(p.b - p.a);
      const span = document.createElement('span');
      span.className = `${CLASS} ${CLASS}--${s.kind}`;
      span.dataset.ks = String(s.i);
      tail.parentNode!.insertBefore(span, tail);
      span.appendChild(tail);
    }
  }
  return spans.length;
}

/** The key sentence a click landed on, from the event's path. */
export function keyIndexFromPath(path: EventTarget[]): number | null {
  const span = path.find((n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains(CLASS) && n.dataset.ks !== undefined);
  return span ? Number(span.dataset.ks) : null;
}

/** All the spans of one key sentence (it can cross links and bold text). */
export function keySpans(root: Root, index: number): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`span.${CLASS}[data-ks="${index}"]`));
}

/** Scrolls a key sentence into view and flashes it. */
export function revealKey(root: Root, index: number) {
  const spans = keySpans(root, index);
  if (!spans.length) return false;
  spans[0]!.scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const s of spans) {
    s.classList.remove('ks--flash');
    void s.offsetWidth;
    s.classList.add('ks--flash');
  }
  return true;
}

/** The positions (data-ks) of drawn key sentences, in reading order. */
export function drawnKeys(root: Root, hidden: Set<KeyKind>): number[] {
  const out: number[] = [];
  for (const s of Array.from(root.querySelectorAll<HTMLElement>(`span.${CLASS}`))) {
    const i = Number(s.dataset.ks);
    const kind = KEY_KINDS.find((k) => s.classList.contains(`${CLASS}--${k}`));
    if (kind && hidden.has(kind)) continue;
    if (!out.includes(i)) out.push(i);
  }
  return out;
}

/**
 * Styles for key sentences. `host` wraps a condition on the article's outer
 * element: ":host(X)" inside the shadow root, ".reader__text X" for text-only
 * articles. Attributes on that element: data-ks-off (colours off),
 * data-ks-hide="main caveat" (kinds hidden), data-ks-skim (fade the rest).
 */
export function keyCss(host: (attr: string) => string): string {
  const lines: string[] = [
    `.ks { border-radius: 2px; cursor: pointer; -webkit-box-decoration-break: clone; box-decoration-break: clone; }`,
    `@keyframes ksflash { 0%, 100% { outline-color: transparent; } 40% { outline-color: var(--teal, #0b6b66); } }`,
    `.ks--flash { outline: 2px solid transparent; outline-offset: 2px; animation: ksflash 1.2s ease 2; }`,
  ];
  const dark: string[] = [];
  for (const k of KEY_KINDS) {
    const c = KEY_COLOURS[k];
    lines.push(`.ks--${k} { background: ${c.light[0]}; box-shadow: inset 0 -2px 0 ${c.light[1]}; }`);
    dark.push(`.ks--${k} { background: ${c.dark[0]}; box-shadow: inset 0 -2px 0 ${c.dark[1]}; }`);
    lines.push(`${host(`[data-ks-hide~="${k}"]`)} .ks--${k} { background: none; box-shadow: none; cursor: auto; }`);
  }
  lines.push(`${host('[data-ks-off]')} .ks { background: none; box-shadow: none; cursor: auto; }`);
  // Skim: everything fades but the key sentences (and your own highlights).
  const faded = 'color-mix(in srgb, var(--ink, #16191d) 32%, transparent)';
  lines.push(
    `${host('[data-ks-skim]')}, ${host('[data-ks-skim]')} * { color: ${faded} !important; transition: color 0.2s; }`,
    `${host('[data-ks-skim]')} img { opacity: 0.35; }`,
    `${host('[data-ks-skim]')} .ks, ${host('[data-ks-skim]')} .ks *, ${host('[data-ks-skim]')} mark.hl, ${host('[data-ks-skim]')} mark.hl * { color: var(--ink, #16191d) !important; }`,
  );
  for (const k of KEY_KINDS) lines.push(`${host(`[data-ks-skim][data-ks-hide~="${k}"]`)} .ks--${k} { color: ${faded} !important; }`);
  return `${lines.join('\n')}\n@media (prefers-color-scheme: dark) {\n${dark.join('\n')}\n}\n@media (prefers-reduced-motion: reduce) { .ks--flash { animation: none; outline-color: var(--teal, #0b6b66); } }`;
}

/** For the article's shadow root. */
export const KEY_CSS = keyCss((attr) => `:host(${attr})`);

/** The element the data-ks-* switches go on: the shadow root's host, or the text-only article itself. */
export const keyHost = (root: Root): HTMLElement => (root instanceof ShadowRoot ? (root.host as HTMLElement) : root);

/** Sets the switches on the article's outer element. */
export function setKeyView(root: Root, view: { on: boolean; skim: boolean; hidden: Set<KeyKind> }) {
  const el = keyHost(root);
  el.toggleAttribute('data-ks-off', !view.on);
  el.toggleAttribute('data-ks-skim', view.on && view.skim);
  if (view.hidden.size) el.setAttribute('data-ks-hide', [...view.hidden].join(' '));
  else el.removeAttribute('data-ks-hide');
}

export function clearKeyView(root: Root) {
  const el = keyHost(root);
  el.removeAttribute('data-ks-off');
  el.removeAttribute('data-ks-skim');
  el.removeAttribute('data-ks-hide');
}

let textCssAdded = false;
/** Text-only articles are drawn in the page itself, so their key sentence styles go in the page's head (once). */
export function addKeyTextCss() {
  if (textCssAdded || typeof document === 'undefined') return;
  textCssAdded = true;
  const style = document.createElement('style');
  style.textContent = keyCss((attr) => `.reader__text${attr}`);
  document.head.append(style);
}

/** The dot colour for a kind, following the light or dark theme (tokens in styles.css). */
export const kindDot = (k: KeyKind) => `var(--ks-${k}, ${KEY_COLOURS[k].light[1]})`;

/** Whether key sentences are switched on (from /api/me), for inbox rows that can't easily be told. */
let keysOn = false;
export const setKeysShown = (on: boolean) => {
  keysOn = on;
};
export const keysShown = () => keysOn;
