import DOMPurify from 'dompurify';
import type { Highlight } from '@newsletterapp/shared';
import { useEffect, useRef } from 'react';
import { applyMarks, MARK_CSS } from '../highlight';
import { KEY_CSS, keyIndexFromPath } from '../keySentences';

const BASE_CSS = `
  :host { display: block; color: inherit; line-height: 1.5; overflow-wrap: anywhere; }
  [data-sponsored] { display: none !important; }
  :host([data-show-sponsored]) [data-sponsored] { display: revert !important; outline: 2px dashed rgba(217,119,6,0.5); outline-offset: 2px; }
  img { max-width: 100% !important; height: auto !important; }
  img[data-blocked-src] { display: inline-block; min-width: 24px; min-height: 24px; background: rgba(127,127,127,0.15); border-radius: 4px; }
  .img-caption { display: block; margin: 4px 0 12px; font-size: 0.9em; font-style: italic; color: var(--quiet, #4a5259); }
  table { max-width: 100% !important; border-collapse: collapse; }
  [width], [style*="width"] { max-width: 100% !important; }
  td, th { word-break: break-word; }
  pre { white-space: pre-wrap; }
  a { color: var(--teal); }
  body { margin: 0; }
  :host { position: relative; }
  .story-links { margin-top: 1.5em; padding-top: 0.6em; border-top: 1px solid rgba(127,127,127,0.3); }
  .story-links h2 { font-size: 1em; margin: 0 0 0.4em; }
  .story-links__row { margin: 0.35em 0; font-size: 0.95em; line-height: 1.6; }
  .story-links__head { margin: 0.8em 0 0.2em; font-size: 0.9em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted, #5b6470); }
  .story-links__list { margin: 0; padding-left: 1.1em; }
  .story-links__list li { margin: 0.45em 0; }
  .story-links__peek { display: block; font-size: 0.9em; color: var(--muted, #5b6470); line-height: 1.4; }
  .story-links__all summary { cursor: pointer; color: var(--teal); font-size: 0.9em; margin-top: 0.4em; }
  .story-links__all li { margin: 0.3em 0; font-size: 0.92em; }
  a[data-peek] { position: relative; text-decoration-style: dotted; text-underline-offset: 3px; }
  @media (hover: hover) {
    a[data-peek]:hover::after {
      content: attr(data-peek); position: absolute; left: 0; top: 100%; z-index: 5; margin-top: 4px;
      width: max-content; max-width: min(320px, 70vw); padding: 6px 9px; border-radius: 8px;
      background: var(--surface, #fff); color: var(--ink, #1d2327); box-shadow: 0 4px 18px rgba(0,0,0,0.22);
      font-size: 0.85em; font-weight: normal; line-height: 1.35; white-space: normal; pointer-events: none;
    }
  }
  .peek {
    position: absolute; z-index: 10; max-width: min(320px, calc(100% - 8px)); padding: 9px 11px; border-radius: 10px;
    background: var(--surface, #fff); color: var(--ink, #1d2327); box-shadow: 0 6px 22px rgba(0,0,0,0.25);
    font-size: 0.88em; line-height: 1.4;
  }
  .peek__open { display: inline-block; margin-top: 6px; font-weight: 600; }
`;

/** Phones and tablets: no hover, so a first tap on a Techmeme-style link shows its headline or comment. */
const touchOnly = () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;

function showPeek(root: ShadowRoot, host: HTMLElement, anchor: HTMLAnchorElement) {
  const bubble = document.createElement('div');
  bubble.className = 'peek';
  bubble.dataset.for = anchor.href;
  const text = document.createElement('div');
  text.textContent = anchor.dataset.peek ?? '';
  const open = document.createElement('a');
  open.className = 'peek__open';
  open.href = anchor.href;
  open.target = '_blank';
  open.rel = 'noopener noreferrer nofollow';
  open.textContent = `Open ${anchor.textContent?.trim() || 'link'} ↗`;
  bubble.append(text, open);
  root.append(bubble);
  const hostBox = host.getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const width = bubble.offsetWidth;
  bubble.style.top = `${a.bottom - hostBox.top + 6}px`;
  bubble.style.left = `${Math.max(0, Math.min(a.left - hostBox.left, hostBox.width - width - 4))}px`;
}

const REMOTE = /^(https?:)?\/\//i;

/** A link to a page of this app, e.g. an AI note's link back to its article. */
const isInternal = (href: string | null) => Boolean(href && /^\/item\/[\w-]+$/.test(href));

/**
 * Hover text (the title attribute) never shows on a phone, and for comics such
 * as xkcd it is the punchline. Put it under the image as a caption instead,
 * after the link when the image is one.
 */
function addCaption(img: HTMLImageElement) {
  const title = (img.getAttribute('title') ?? '').trim();
  if (!title || title === (img.getAttribute('alt') ?? '').trim()) return;
  const after = img.closest('a') ?? img;
  const caption = img.ownerDocument.createElement('span');
  caption.className = 'img-caption';
  caption.textContent = title;
  after.insertAdjacentElement('afterend', caption);
}

// Words that open a sponsored block. Matched against a block's own text,
// so a long article that merely mentions "sponsored" is left alone.
const SPONSOR_MARK =
  /^\s*(sponsored(\s+(by|content|post|message|section))?|presented by|brought to you by|in partnership with|together with|paid partnership|advertisement|a message from( our)? (sponsor|partner)|from our (sponsor|partner)s?|partner content|promoted)\b/i;
const MAX_SPONSOR_CHARS = 1500; // a sponsored block is a few paragraphs, not the whole issue

/**
 * Marks sponsored blocks so the stylesheet can hide them. A block is the
 * nearest table/row/cell/div ancestor of a sponsor label that is still short
 * enough to be an ad, not the whole newsletter.
 */
function markSponsored(fragment: DocumentFragment): number {
  let count = 0;
  const marked: Element[] = [];
  for (const el of fragment.querySelectorAll('p, td, div, span, h1, h2, h3, h4, h5, h6, strong, b, em')) {
    const own = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (own.length === 0 || own.length > 80 || !SPONSOR_MARK.test(own)) continue;
    if (marked.some((m) => m.contains(el))) continue;
    // Climb to the biggest block that is still short enough to be the ad itself.
    let block: Element = el;
    for (let up = el.parentElement; up && !(up instanceof DocumentFragment); up = up.parentElement) {
      if (!/^(table|tr|td|div|section|article|li|blockquote)$/i.test(up.tagName)) continue;
      if ((up.textContent ?? '').replace(/\s+/g, ' ').trim().length > MAX_SPONSOR_CHARS) break;
      block = up;
    }
    if (block === el && /^(span|strong|b|em)$/i.test(el.tagName)) continue; // just a word in running text
    block.setAttribute('data-sponsored', '');
    marked.push(block);
    count++;
  }
  return count;
}

/**
 * Renders newsletter HTML safely: DOMPurify strips scripts and friends, and a
 * shadow root keeps the email's own styles from leaking into the app.
 * Remote images stay blocked until the reader asks for them, so senders
 * cannot tell when you open an issue.
 */
export function EmailBody({
  html,
  loadImages,
  fontSize = 16,
  hideSponsored = false,
  onSponsored,
  onLinkClick,
  highlights,
  activeHighlight = null,
  onRoot,
  onHighlightTap,
  onInternalLink,
  onMissing,
  onDrawn,
  onKeyTap,
}: {
  html: string;
  loadImages: boolean;
  /** Base font size inside the email, in px. */
  fontSize?: number;
  /** Hide blocks that look like sponsored sections. */
  hideSponsored?: boolean;
  /** How many sponsored blocks were found, hidden or not. */
  onSponsored?: (count: number) => void;
  onLinkClick?: (href: string) => void;
  /** Saved highlights to mark in the text. */
  highlights?: Highlight[];
  activeHighlight?: string | null;
  /** The shadow root the article is drawn in, for reading selections. */
  onRoot?: (root: ShadowRoot) => void;
  onHighlightTap?: (id: string) => void;
  /** Links to another page of this app (AI notes link back to their article). */
  onInternalLink?: (path: string) => void;
  /** Highlights that couldn't be found in this version of the text. */
  onMissing?: (ids: string[]) => void;
  /** Called each time the article is drawn afresh (key sentences are marked again then). */
  onDrawn?: (root: ShadowRoot) => void;
  /** A tap on a key sentence: its position in the key sentence list. */
  onKeyTap?: (index: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const marks = useRef<{ highlights: Highlight[]; active: string | null }>({ highlights: [], active: null });
  marks.current = { highlights: highlights ?? [], active: activeHighlight };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

    const fragment = DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      WHOLE_DOCUMENT: false,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base'],
      FORBID_ATTR: ['onerror', 'onload'],
      ADD_ATTR: ['target'],
    });

    for (const img of fragment.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? '';
      if (REMOTE.test(src)) {
        if (!loadImages) {
          img.setAttribute('data-blocked-src', src);
          img.removeAttribute('src');
          img.removeAttribute('srcset');
        }
      }
      img.removeAttribute('loading');
      // Sites that refuse pictures shown on other sites (hotlink protection) still serve a
      // request that doesn't say where it came from; it also keeps reading private.
      img.setAttribute('referrerpolicy', 'no-referrer');
      addCaption(img);
    }
    if (!loadImages) {
      for (const el of fragment.querySelectorAll<HTMLElement>('[style*="url("], [background]')) {
        el.removeAttribute('background');
        el.style.backgroundImage = 'none';
      }
    }
    for (const a of fragment.querySelectorAll('a')) {
      if (isInternal(a.getAttribute('href'))) {
        a.removeAttribute('target');
        continue;
      }
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer nofollow');
    }

    const found = markSponsored(fragment);
    onSponsored?.(found);
    if (hideSponsored) host.removeAttribute('data-show-sponsored');
    else host.setAttribute('data-show-sponsored', '');

    const style = document.createElement('style');
    style.textContent = `${BASE_CSS}\n${MARK_CSS}\n${KEY_CSS}\n:host { font-size: ${fontSize}px; }`;
    root.replaceChildren(style, fragment);
    onMissing?.(applyMarks(root, marks.current.highlights, marks.current.active));
    onRoot?.(root);
    onDrawn?.(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, loadImages, fontSize, hideSponsored]);

  // Marks again when the highlights change, without redrawing the article.
  const key = (highlights ?? []).map((h) => h.id).join(',');
  useEffect(() => {
    const root = hostRef.current?.shadowRoot;
    if (root) onMissing?.(applyMarks(root, marks.current.highlights, marks.current.active));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, activeHighlight]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handler = (e: Event) => {
      const path = e.composedPath();
      const anchor = path.find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement);
      const href = anchor?.getAttribute('href') ?? null;
      // Tap-to-peek: the first tap shows the headline or comment, a second tap (or Open) follows the link.
      const root = host.shadowRoot;
      const bubble = root?.querySelector<HTMLElement>('.peek') ?? null;
      const inBubble = bubble !== null && path.includes(bubble);
      if (bubble && !inBubble) bubble.remove();
      if (root && anchor?.dataset.peek && !inBubble && touchOnly() && bubble?.dataset.for !== anchor.href) {
        e.preventDefault();
        showPeek(root, host, anchor);
        return;
      }
      if (anchor && isInternal(href) && onInternalLink) {
        e.preventDefault();
        onInternalLink(href!);
        return;
      }
      if (anchor?.href) {
        onLinkClick?.(anchor.href);
        return;
      }
      const mark = path.find((n): n is HTMLElement => n instanceof HTMLElement && n.tagName === 'MARK' && Boolean(n.dataset.hl));
      // A tap that ends a selection isn't a tap on the highlight.
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (mark && onHighlightTap) {
        onHighlightTap(mark.dataset.hl!);
        return;
      }
      const key = keyIndexFromPath(path);
      if (key !== null && onKeyTap && !host.hasAttribute('data-ks-off')) onKeyTap(key);
    };
    host.addEventListener('click', handler);
    return () => host.removeEventListener('click', handler);
  }, [onLinkClick, onHighlightTap, onInternalLink, onKeyTap]);

  return <div ref={hostRef} />;
}
