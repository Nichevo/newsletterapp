import DOMPurify from 'dompurify';
import { useEffect, useRef } from 'react';

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
`;

const REMOTE = /^(https?:)?\/\//i;

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
}) {
  const hostRef = useRef<HTMLDivElement>(null);

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
      addCaption(img);
    }
    if (!loadImages) {
      for (const el of fragment.querySelectorAll<HTMLElement>('[style*="url("], [background]')) {
        el.removeAttribute('background');
        el.style.backgroundImage = 'none';
      }
    }
    for (const a of fragment.querySelectorAll('a')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer nofollow');
    }

    const found = markSponsored(fragment);
    onSponsored?.(found);
    if (hideSponsored) host.removeAttribute('data-show-sponsored');
    else host.setAttribute('data-show-sponsored', '');

    const style = document.createElement('style');
    style.textContent = `${BASE_CSS}\n:host { font-size: ${fontSize}px; }`;
    root.replaceChildren(style, fragment);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, loadImages, fontSize, hideSponsored]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !onLinkClick) return;
    const handler = (e: Event) => {
      const path = e.composedPath();
      const anchor = path.find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement);
      if (anchor?.href) onLinkClick(anchor.href);
    };
    host.addEventListener('click', handler);
    return () => host.removeEventListener('click', handler);
  }, [onLinkClick]);

  return <div ref={hostRef} />;
}
