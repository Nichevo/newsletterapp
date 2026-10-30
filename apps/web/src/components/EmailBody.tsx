import DOMPurify from 'dompurify';
import { useEffect, useRef } from 'react';

const BASE_CSS = `
  :host { display: block; color: inherit; font-size: 16px; line-height: 1.5; overflow-wrap: anywhere; }
  img { max-width: 100% !important; height: auto !important; }
  img[data-blocked-src] { display: inline-block; min-width: 24px; min-height: 24px; background: rgba(127,127,127,0.15); border-radius: 4px; }
  table { max-width: 100% !important; border-collapse: collapse; }
  [width], [style*="width"] { max-width: 100% !important; }
  td, th { word-break: break-word; }
  pre { white-space: pre-wrap; }
  a { color: var(--teal); }
  body { margin: 0; }
`;

const REMOTE = /^(https?:)?\/\//i;

/**
 * Renders newsletter HTML safely: DOMPurify strips scripts and friends, and a
 * shadow root keeps the email's own styles from leaking into the app.
 * Remote images stay blocked until the reader asks for them, so senders
 * cannot tell when you open an issue.
 */
export function EmailBody({
  html,
  loadImages,
  onLinkClick,
}: {
  html: string;
  loadImages: boolean;
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

    const style = document.createElement('style');
    style.textContent = BASE_CSS;
    root.replaceChildren(style, fragment);
  }, [html, loadImages]);

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
